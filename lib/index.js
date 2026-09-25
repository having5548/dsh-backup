// ============================================================================
// dsh-backup —— DSH 备份与恢复插件（服务端半部）
//
// 路由（全部挂在 /dsh-backup/ 前缀下）：
//   GET  /dsh-backup/status           数据目录状态（轻量）
//   GET  /dsh-backup/estimate         按组件估算体积/文件数
//   GET  /dsh-backup/export           导出 ZIP 备份包（流式，浏览器直接下载）
//   POST /dsh-backup/import           上传备份包：mode=preview 预检 / mode=execute 直接导入
//   POST /dsh-backup/import/execute   凭预检 token 复用已落盘的包执行导入
//
// 设计要点见 lib/store.js 顶部注释（会话字节级复制 / 格式兼容 / mnemon 保真）。
// ============================================================================

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import z from 'schemastery'

import {
  ZipWriter, ZipReader, crc32, sanitizeZipName,
} from './zip.js'
import {
  FORMAT, FORMAT_VERSION, MANIFEST_NAME, CHECKSUMS_NAME,
  COMPONENTS, resolveLayout, collectEstimate, collectCounts, buildManifest,
  collectExportFiles, planImport, extractPayload, applyImport, cleanupStale,
  pathExists, componentSources,
} from './store.js'

const name = 'dsh-backup'
const inject = ['webServer', 'settings']
const PLUGIN_VERSION = '0.1.0'
const ROUTE_PREFIX = '/dsh-backup/'

// ---- 设置命名空间（DSH Web UI 设置 → 备份与恢复） ----
const SETTINGS_NAMESPACE = 'dsh-backup'
const BackupSettingsSchema = z.object({
  defaultImportMode: z.string().default('merge'),
  verifyChecksums: z.boolean().default(true),
})

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
}

const MAX_UPLOAD_BYTES = 16 * 1024 * 1024 * 1024 // 16 GiB
const SPOOL_KEEP_MS = 60 * 60 * 1000
const SPOOL_KEEP_COUNT = 3

function json(res, status, obj) {
  res.writeHead(status, JSON_HEADERS)
  res.end(JSON.stringify(obj))
}

function httpError(res, status, message) {
  json(res, status, { ok: false, error: String(message).slice(0, 500) })
}

/**
 * 同源防护：浏览器总会为跨站请求带 Origin / Sec-Fetch-Site。
 * 拦住其它网页对本插件路由的 CSRF；本机进程直接访问与 dsh 自身 API 同一威胁面，不在此处理。
 */
function sameOrigin(req) {
  const origin = req.headers.origin
  if (origin && origin !== 'null') {
    try {
      const o = new URL(origin)
      const host = req.headers.host
      if (host && o.host !== host) return false
    } catch {
      return false
    }
  }
  const site = req.headers['sec-fetch-site']
  if (site && site !== 'same-origin' && site !== 'same-site' && site !== 'none') return false
  return true
}

function parseComponents(searchParams) {
  const raw = String(searchParams.get('components') || '').trim()
  const valid = new Set(COMPONENTS.map((c) => c.id))
  if (!raw) return null // null = 全部（导出默认不含 extensions）
  const ids = raw.split(',').map((s) => s.trim()).filter(Boolean)
  const unknown = ids.filter((id) => !valid.has(id))
  if (unknown.length > 0) throw new Error('未知组件：' + unknown.join(', '))
  return new Set(ids)
}

function spoolDir() {
  return path.join(os.tmpdir(), 'dsh-backup-spool')
}

/** 上传体落盘（带大小上限），返回 spool 文件路径。 */
function spoolRequest(req) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(spoolDir(), { recursive: true })
    const token = crypto.randomBytes(16).toString('hex')
    const abs = path.join(spoolDir(), token + '.zip')
    const ws = fs.createWriteStream(abs)
    let received = 0
    let settled = false
    const fail = (err) => {
      if (settled) return
      settled = true
      fs.unlink(abs, () => {})
      reject(err)
    }
    req.on('data', (chunk) => {
      received += chunk.length
      if (received > MAX_UPLOAD_BYTES) {
        req.destroy()
        fail(new Error('备份包超过 16GiB 上限'))
        return
      }
      if (!ws.write(chunk)) {
        req.pause()
        ws.once('drain', () => req.resume())
      }
    })
    req.on('error', fail)
    ws.on('error', fail)
    ws.on('finish', () => {
      if (settled) return
      settled = true
      resolve({ abs, token, bytes: received })
    })
  })
}

// 预检 token → spool 文件登记表（同进程内存；dsh 重启后 token 失效，客户端重新预检即可）
const spoolRegistry = new Map()

function registerSpool(token, abs, bytes) {
  spoolRegistry.set(token, { abs, bytes, ts: Date.now() })
  // 只保留最近 N 份
  while (spoolRegistry.size > SPOOL_KEEP_COUNT) {
    const oldest = [...spoolRegistry.entries()].sort((a, b) => a[1].ts - b[1].ts)[0]
    if (!oldest) break
    spoolRegistry.delete(oldest[0])
    fs.unlink(oldest[1].abs, () => {})
  }
}

async function cleanupSpools() {
  let items
  try { items = await fs.promises.readdir(spoolDir()) } catch { return }
  const now = Date.now()
  for (const item of items) {
    if (!item.endsWith('.zip')) continue
    const abs = path.join(spoolDir(), item)
    const stat = await fs.promises.stat(abs).catch(() => null)
    if (stat && now - stat.mtimeMs > SPOOL_KEEP_MS) {
      await fs.promises.unlink(abs).catch(() => {})
    }
  }
  for (const [token, rec] of spoolRegistry) {
    if (now - rec.ts > SPOOL_KEEP_MS) {
      spoolRegistry.delete(token)
      fs.unlink(rec.abs, () => {})
    }
  }
}

async function openBackup(abs, { verifyManifest = true } = {}) {
  const reader = new ZipReader(abs)
  await reader.open()
  const manifestEntry = reader.entries.find((e) => e.name === MANIFEST_NAME)
  if (!manifestEntry) {
    await reader.close()
    throw new Error('这不是有效的 DSH 备份包（缺少 manifest.json）')
  }
  const manifest = JSON.parse((await reader.readEntry(manifestEntry)).toString('utf8'))
  if (manifest.format !== FORMAT) {
    await reader.close()
    throw new Error(`备份格式不符：${manifest.format || '未知'}（期望 ${FORMAT}）`)
  }
  if (Number(manifest.formatVersion) > FORMAT_VERSION) {
    await reader.close()
    throw new Error(`备份格式版本过新：v${manifest.formatVersion}（本插件支持到 v${FORMAT_VERSION}），请升级 dsh-backup 插件后再导入`)
  }
  let checksums = null
  const checksumEntry = reader.entries.find((e) => e.name === CHECKSUMS_NAME)
  if (checksumEntry) {
    try { checksums = JSON.parse((await reader.readEntry(checksumEntry)).toString('utf8')) } catch { /* 校验文件损坏不阻塞 */ }
  }
  if (verifyManifest && checksums && typeof checksums.manifest === 'string') {
    const raw = (await reader.readEntry(manifestEntry))
    const h = crypto.createHash('sha256')
    h.update(raw)
    if (h.digest('hex') !== String(checksums.manifest).toLowerCase()) {
      await reader.close()
      throw new Error('manifest.json 校验失败：备份包可能已损坏或不完整')
    }
  }
  return { reader, manifest, checksums }
}

function safeManifestSubset(manifest) {
  return {
    format: manifest.format,
    formatVersion: manifest.formatVersion,
    createdAt: manifest.createdAt,
    producer: manifest.producer,
    source: manifest.source,
    counts: manifest.counts,
    components: manifest.components,
    bundles: manifest.bundles,
  }
}

// ---------------------------------------------------------------------------
// 导出
// ---------------------------------------------------------------------------

async function handleExport(req, res, searchParams) {
  const layout = resolveLayout()
  let components
  try {
    components = parseComponents(searchParams) || new Set(COMPONENTS.filter((c) => c.id !== 'extensions').map((c) => c.id))
  } catch (err) {
    return httpError(res, 400, (err && err.message) || err)
  }

  // ---- 收集文件清单（一次遍历，同时得出 manifest 统计） ----
  const { files, componentStats } = await collectExportFiles(layout, components)
  for (const f of files) f.zipPath = sanitizeZipName(f.zipPath)

  const manifest = await buildManifest(layout, [...components], componentStats)

  const filename = 'dsh-backup-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '.zip'
  res.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Disposition': 'attachment; filename="' + filename + '"',
    'Cache-Control': 'no-store',
    'X-Dsh-Backup-Format': String(FORMAT_VERSION),
  })

  let aborted = false
  req.on('error', () => { aborted = true })
  res.on('error', () => { aborted = true })
  const sink = {
    async write(chunk) {
      if (aborted) throw new Error('客户端已断开')
      if (res.write(chunk)) return
      await new Promise((resolve) => res.once('drain', resolve))
    },
  }

  const writer = new ZipWriter(sink)
  try {
    const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2), 'utf8')
    const h = crypto.createHash('sha256')
    h.update(manifestBytes)
    const checksums = {
      algorithm: 'zip-entry-crc32 + manifest-sha256',
      manifest: h.digest('hex'),
      files: {},
    }
    for (const f of files) {
      checksums.files[f.zipPath] = { size: f.size }
    }

    await writer.addBuffer(MANIFEST_NAME, manifestBytes)
    for (const f of files) {
      if (aborted) break
      await writer.addFromFile(f.abs, f.zipPath, { mtime: f.mtime })
    }
    await writer.addBuffer(CHECKSUMS_NAME, Buffer.from(JSON.stringify(checksums, null, 2), 'utf8'))
    await writer.close()
    res.end()
  } catch (err) {
    aborted = true
    try { res.destroy() } catch { /* ignore */ }
    if (!res.headersSent) {
      httpError(res, 500, '导出失败：' + String((err && err.message) || err))
    }
  }
}

// ---------------------------------------------------------------------------
// 路由处理
// ---------------------------------------------------------------------------

async function handleStatus(res) {
  const layout = resolveLayout()
  const counts = await collectCounts(layout)
  const components = COMPONENTS.map((c) => ({ id: c.id, label: c.label }))
  json(res, 200, {
    ok: true,
    pluginVersion: PLUGIN_VERSION,
    formatVersion: FORMAT_VERSION,
    dshHome: layout.dshHome,
    profile: layout.profileName,
    profileDir: layout.profileDir,
    mnemonRoot: layout.mnemonRoot,
    node: process.version,
    platform: process.platform,
    counts,
    components,
    importBusy,
  })
}

async function handleEstimate(res, searchParams) {
  const layout = resolveLayout()
  let ids
  try {
    const set = parseComponents(null, searchParams) || new Set(COMPONENTS.map((c) => c.id))
    ids = [...set]
  } catch (err) {
    return httpError(res, 400, (err && err.message) || err)
  }
  const estimate = await collectEstimate(layout, ids)
  json(res, 200, { ok: true, ...estimate })
}

async function handleImportPreview(res, spool) {
  const { reader, manifest, checksums } = await openBackup(spool.abs)
  try {
    const layout = resolveLayout()
    const components = new Set(COMPONENTS.map((c) => c.id))
    const plan = await planImport(reader, { layout, mode: 'merge', components, manifest, checksums })
    registerSpool(spool.token, spool.abs, spool.bytes)
    json(res, 200, {
      ok: true,
      token: spool.token,
      bytes: spool.bytes,
      manifest: safeManifestSubset(manifest),
      plan,
    })
  } finally {
    await reader.close()
  }
}

let importBusy = false

async function runImport({ layout, mode, components, verify, spoolAbs, res }) {
  if (importBusy) return httpError(res, 409, '已有导入正在进行，请稍后再试')
  importBusy = true
  try {
    const { reader, manifest, checksums } = await openBackup(spoolAbs)
    try {
      const plan = await planImport(reader, { layout, mode, components, manifest, checksums })
      if (plan.components.mnemon && plan.components.mnemon.invalid && plan.components.mnemon.invalid.length > 0 && mode === 'replace') {
        return httpError(res, 422, '备份 mnemon 数据不完整：' + plan.components.mnemon.invalid[0])
      }
      const { stagingRootDsh, stagingRootMnemon, extracted } = await extractPayload(reader, reader.entries, layout, checksums, verify)
      try {
        const report = await applyImport(reader, { layout, mode, components, manifest, extracted, plan })
        json(res, 200, { ok: report.ok, report })
      } finally {
        // 清暂存（成功失败都要清；失败时 bak 已落地，能人工恢复）
        await fs.promises.rm(stagingRootDsh, { recursive: true, force: true }).catch(() => {})
        await fs.promises.rm(stagingRootMnemon, { recursive: true, force: true }).catch(() => {})
      }
    } finally {
      await reader.close()
    }
  } catch (err) {
    httpError(res, 500, String((err && err.message) || err))
  } finally {
    importBusy = false
  }
}

function readSettingsGet(settingsScope, field, fallback) {
  try {
    const v = settingsScope && settingsScope.get()
    if (v && typeof v === 'object' && v[field] !== undefined) return v[field]
  } catch { /* ignore */ }
  return fallback
}

// ---------------------------------------------------------------------------
// 插件入口
// ---------------------------------------------------------------------------

export function apply(ctx) {
  let settingsScope = null
  try {
    settingsScope = ctx.settings.register(SETTINGS_NAMESPACE, BackupSettingsSchema, { applies: 'live' })
  } catch (err) { /* 命名空间已注册或设置服务不可用时继续 */ }

  ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: async (req, res) => {
      let url
      try {
        url = new URL(req.url, 'http://localhost')
      } catch {
        return httpError(res, 400, 'bad request')
      }
      const pathname = url.pathname.replace(/\/+$/, '/')
      const searchParams = url.searchParams
      const isGet = req.method === 'GET' || req.method === 'HEAD'
      const isPost = req.method === 'POST'

      try {
        if (!sameOrigin(req)) return httpError(res, 403, 'cross-origin request rejected')

        if (isGet && pathname === '/dsh-backup/status') return await handleStatus(res)
        if (isGet && pathname === '/dsh-backup/estimate') return await handleEstimate(res, searchParams)
        if (isGet && pathname === '/dsh-backup/export') return await handleExport(req, res, searchParams)

        if (isPost && pathname === '/dsh-backup/import/execute') {
          // 凭预检 token 复用已落盘的备份包
          const token = String(searchParams.get('token') || '')
          const rec = spoolRegistry.get(token)
          if (!rec) return httpError(res, 409, '预检信息已过期（服务可能重启过），请重新选择文件预检')
          const layout = resolveLayout()
          let mode = String(searchParams.get('mode') || '') || readSettingsGet(settingsScope, 'defaultImportMode', 'merge')
          if (mode !== 'merge' && mode !== 'replace') return httpError(res, 400, 'mode 必须是 merge 或 replace')
          const components = parseComponents(null, searchParams) || new Set(COMPONENTS.map((c) => c.id))
          const verify = searchParams.get('verify') === null
            ? !!readSettingsGet(settingsScope, 'verifyChecksums', true)
            : searchParams.get('verify') !== '0'
          const out = await runImport({ layout, mode, components, verify, spoolAbs: rec.abs, res })
          // 导入完成后清掉这份 spool
          spoolRegistry.delete(token)
          fs.unlink(rec.abs, () => {})
          return out
        }

        if (isPost && pathname === '/dsh-backup/import') {
          const mode = String(searchParams.get('mode') || 'preview')
          if (!['preview', 'execute'].includes(mode)) return httpError(res, 400, 'mode 必须是 preview 或 execute')
          const spool = await spoolRequest(req)
          try {
            if (mode === 'preview') return await handleImportPreview(res, spool)
            const layout = resolveLayout()
            const components = parseComponents(null, searchParams) || new Set(COMPONENTS.map((c) => c.id))
            const verify = searchParams.get('verify') === null
              ? !!readSettingsGet(settingsScope, 'verifyChecksums', true)
              : searchParams.get('verify') !== '0'
            const out = await runImport({ layout, mode, components, verify, spoolAbs: spool.abs, res })
            fs.unlink(spool.abs, () => {})
            return out
          } catch (err) {
            fs.unlink(spool.abs, () => {})
            return httpError(res, 400, String((err && err.message) || err))
          }
        }

        return httpError(res, 404, 'not found: ' + pathname)
      } catch (err) {
        return httpError(res, 500, String((err && err.message) || err))
      }
    },
  })

  // 周期清理过期 spool（每小时一次足够）
  const timer = setInterval(() => { cleanupSpools().catch(() => {}) }, 60 * 60 * 1000)
  if (typeof timer.unref === 'function') timer.unref()
  cleanupStale(resolveLayout()).catch(() => {})

  ctx.effect(() => () => {
    clearInterval(timer)
  }, 'dsh-backup: server')
}

export { apply as default, name, inject }
