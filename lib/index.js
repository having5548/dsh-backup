// ============================================================================
// dsh-backup —— DSH 备份与恢复插件（服务端半部）
//
// HTTP 路由（全部挂在 /dsh-backup/ 前缀下）：
//   GET  /dsh-backup/status           数据目录状态（轻量）
//   GET  /dsh-backup/estimate         按组件估算体积/文件数
//   GET  /dsh-backup/export           导出 ZIP 备份包（流式，浏览器直接下载）
//   POST /dsh-backup/import           上传备份包：mode=preview 预检 / mode=execute 直接导入
//   POST /dsh-backup/import/execute   凭预检 token 复用已落盘的包执行导入
//   POST /dsh-backup/backup-now       立即备份到磁盘备份目录（含 .sha256 + 救援工具）
//   GET  /dsh-backup/disk             列出磁盘备份目录里的备份
//   GET  /dsh-backup/auto             自动备份状态
//   POST /dsh-backup/auto?hours=N     设置自动备份间隔（0=关闭，1..720 小时）
//   GET  /dsh-backup/doctor           会话日志体检（只读扫描）
//   GET  /dsh-backup/rescue           下载救援控制台工具包（rescue.mjs + 双击启动器）
//
// 斜杠命令（ctx.commands，若宿主可用）：
//   /backup [list|verify|restore|auto|doctor|help]
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
  COMPONENTS, resolveLayout, collectEstimate, collectCounts,
  planImport, extractPayload, applyImport, cleanupStale,
  pathExists, componentSources, assembleBackupZip,
  listBackups, readAutoState, writeAutoState,
  doctorScan,
} from './store.js'
import {
  backupToFile, defaultBackupDir, verifyBackupFile, writeRescueTools,
} from './backupdir.js'

const name = 'dsh-backup'
const inject = ['webServer', 'settings']
const PLUGIN_VERSION = '0.2.0'
const ROUTE_PREFIX = '/dsh-backup/'

// ---- 设置命名空间（DSH Web UI 设置 → 备份与恢复） ----
const SETTINGS_NAMESPACE = 'dsh-backup'
const BackupSettingsSchema = z.object({
  defaultImportMode: z.string().default('merge'),
  verifyChecksums: z.boolean().default(true),
  destination: z.string().default(''),
  keep: z.number().default(7),
  redactSecrets: z.boolean().default(true),
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
// 导出（浏览器下载）
// ---------------------------------------------------------------------------

async function handleExport(req, res, searchParams, settingsGet) {
  const layout = resolveLayout()
  let components
  try {
    components = parseComponents(searchParams) || new Set(COMPONENTS.filter((c) => c.id !== 'extensions').map((c) => c.id))
  } catch (err) {
    return httpError(res, 400, (err && err.message) || err)
  }
  // 脱敏：?redact=1/0 显式覆盖，否则用设置默认（默认开）
  const redactParam = searchParams.get('redact')
  const redactSecrets = redactParam === null
    ? settingsGet('redactSecrets', true) !== false
    : redactParam !== '0'

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

  try {
    const { manifest, fileCount, redacted } = await assembleBackupZip(layout, components, { sink, redactSecrets })
    void manifest
    res.setHeader('X-Dsh-Backup-Files', String(fileCount))
    if (redacted.count > 0) res.setHeader('X-Dsh-Backup-Redacted', String(redacted.count))
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
// 磁盘备份 / 自动备份
// ---------------------------------------------------------------------------

let backupBusy = false

async function destinationOf(settingsGet) {
  const configured = String(settingsGet('destination', '') || '').trim()
  return configured || defaultBackupDir()
}

async function runBackupNow(settingsGet) {
  if (backupBusy) throw new Error('已有备份正在进行，请稍后再试')
  backupBusy = true
  try {
    const layout = resolveLayout()
    const result = await backupToFile({
      layout,
      destination: await destinationOf(settingsGet),
      keep: settingsGet('keep', 7),
      redactSecrets: settingsGet('redactSecrets', true) !== false,
    })
    return result
  } finally {
    backupBusy = false
  }
}

// 自动备份：状态存备份目录 .dsh-backup-auto.json（随目录走、重启后自动续跑）
const autoRuntime = { timer: null, nextRunAt: null }

async function rescheduleAuto(settingsGet, { immediate = false } = {}) {
  if (autoRuntime.timer) { clearTimeout(autoRuntime.timer); autoRuntime.timer = null }
  autoRuntime.nextRunAt = null
  const dest = await destinationOf(settingsGet)
  const state = await readAutoState(dest)
  const hours = Math.floor(Number(state.hours) || 0)
  if (hours <= 0) return { hours: 0, nextRunAt: null }
  const last = Number(state.lastRunAt) || 0
  const interval = hours * 3600_000
  const base = immediate ? Date.now() - interval : last
  let delay = base + interval - Date.now()
  if (delay < 5000) delay = 5000
  autoRuntime.nextRunAt = new Date(Date.now() + delay).toISOString()
  autoRuntime.timer = setTimeout(async () => {
    autoRuntime.timer = null
    try {
      const result = await runBackupNow(settingsGet)
      const dest2 = await destinationOf(settingsGet)
      await writeAutoState(dest2, { ...(await readAutoState(dest2)), hours, lastRunAt: Date.now() })
      void result
    } catch { /* 备份失败不打断调度，下一轮再试 */ }
    rescheduleAuto(settingsGet).catch(() => {})
  }, delay)
  if (typeof autoRuntime.timer.unref === 'function') autoRuntime.timer.unref()
  return { hours, nextRunAt: autoRuntime.nextRunAt }
}

async function setAutoHours(settingsGet, hoursRaw) {
  const n = Math.floor(Number(hoursRaw))
  if (!Number.isFinite(n) || (n !== 0 && (n < 1 || n > 720))) {
    throw new Error('hours 必须是 0（关闭）或 1..720 的整数')
  }
  const dest = await destinationOf(settingsGet)
  const state = await readAutoState(dest)
  await writeAutoState(dest, { ...state, hours: n })
  return rescheduleAuto(settingsGet, { immediate: n > 0 })
}

// ---------------------------------------------------------------------------
// 导入执行（HTTP 与 /backup 命令共用）
// ---------------------------------------------------------------------------

let importBusy = false

async function performImport({ spoolAbs, layout, mode, components, verify, res }) {
  const { reader, manifest, checksums } = await openBackup(spoolAbs)
  try {
    const plan = await planImport(reader, { layout, mode, components, manifest, checksums })
    if (res === null && plan.components.mnemon && plan.components.mnemon.invalid && plan.components.mnemon.invalid.length > 0 && mode === 'replace') {
      throw new Error('备份 mnemon 数据不完整：' + plan.components.mnemon.invalid[0])
    }
    if (res !== null && plan.components.mnemon && plan.components.mnemon.invalid && plan.components.mnemon.invalid.length > 0 && mode === 'replace') {
      return httpError(res, 422, '备份 mnemon 数据不完整：' + plan.components.mnemon.invalid[0])
    }
    const { stagingRootDsh, stagingRootMnemon, extracted } = await extractPayload(reader, reader.entries, layout, checksums, verify)
    try {
      const report = await applyImport(reader, { layout, mode, components, manifest, extracted, plan })
      if (res !== null) json(res, 200, { ok: report.ok, report })
      return report
    } finally {
      // 清暂存（成功失败都要清；失败时 bak 已落地，能人工恢复）
      await fs.promises.rm(stagingRootDsh, { recursive: true, force: true }).catch(() => {})
      await fs.promises.rm(stagingRootMnemon, { recursive: true, force: true }).catch(() => {})
    }
  } catch (err) {
    if (res !== null) httpError(res, 500, String((err && err.message) || err))
    else throw err
  } finally {
    await reader.close()
  }
}

async function runImport({ layout, mode, components, verify, spoolAbs, res }) {
  if (importBusy) return httpError(res, 409, '已有导入正在进行，请稍后再试')
  importBusy = true
  try {
    return await performImport({ spoolAbs, layout, mode, components, verify, res })
  } finally {
    importBusy = false
  }
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

function readSettingsGet(settingsScope, field, fallback) {
  try {
    const v = settingsScope && settingsScope.get()
    if (v && typeof v === 'object' && v[field] !== undefined) return v[field]
  } catch { /* ignore */ }
  return fallback
}

// ---------------------------------------------------------------------------
// 会话体检 / 救援工具包
// ---------------------------------------------------------------------------

async function handleDoctor(res) {
  const layout = resolveLayout()
  const report = await doctorScan(layout)
  json(res, 200, { ok: true, ...report })
}

async function handleRescueDownload(req, res) {
  const rescueDir = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', 'rescue')
  let files = []
  try { files = fs.readdirSync(rescueDir).filter((f) => !f.startsWith('.')) } catch { /* empty */ }
  if (files.length === 0) return httpError(res, 404, '救援工具不可用（插件包中缺少 rescue/ 目录）')

  const filename = 'dsh-backup-rescue.zip'
  res.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Disposition': 'attachment; filename="' + filename + '"',
    'Cache-Control': 'no-store',
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
  try {
    const writer = new ZipWriter(sink)
    for (const f of files) {
      await writer.addFromFile(path.join(rescueDir, f), f)
    }
    await writer.close()
    res.end()
  } catch (err) {
    aborted = true
    try { res.destroy() } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// /backup 斜杠命令
// ---------------------------------------------------------------------------

function fmtBytes(n) {
  if (typeof n !== 'number' || !isFinite(n) || n < 0) return '—'
  if (n < 1024) return n + ' B'
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
  if (n < 1024 * 1024 * 1024) return (n / 1048576).toFixed(1) + ' MB'
  return (n / 1073741824).toFixed(2) + ' GB'
}

function summarizeRestoreReport(report) {
  const c = report.components || {}
  const parts = []
  for (const id of ['sessions', 'projcache', 'attachments', 'extensions']) {
    if (c[id] && (c[id].add || c[id].overwrite || c[id].skip)) {
      parts.push(`${id}: 新增 ${c[id].add || 0} / 覆盖 ${c[id].overwrite || 0} / 保留本机 ${c[id].skip || 0}`)
    }
  }
  if (c.workspaces) parts.push(`workspaces: ${c.workspaces.action === 'merged' ? `合并（+${c.workspaces.added}/更新 ${c.workspaces.updated}）` : c.workspaces.action === 'replaced' ? '已替换' : '未变更'}`)
  if (c.settings) parts.push(`settings: ${c.settings.action === 'replaced' ? '已替换' : c.settings.action === 'skippedMergeMode' ? '合并模式跳过' : '未变更'}`)
  if (c.profile && c.profile.restored && c.profile.restored.length) parts.push(`profile 补缺: ${c.profile.restored.join(', ')}`)
  if (report.mnemon && report.mnemon.applied !== undefined) {
    parts.push(`mnemon: 写入 ${report.mnemon.applied} 项${report.mnemon.errors && report.mnemon.errors.length ? `（${report.mnemon.errors.length} 个错误）` : ''}`)
  }
  const head = report.ok
    ? `导入完成（${Math.round((report.durationMs || 0) / 100) / 10}s，共写入 ${report.applied} 项）`
    : '导入完成但有报错'
  let text = `${head}\n${parts.map((p) => '· ' + p).join('\n') || '· 无变更'}`
  if (report.needsRestart) text += '\n\n建议重启服务并刷新页面，会话列表才会完全刷新。'
  if (report.errors && report.errors.length) text += '\n错误：\n' + report.errors.slice(0, 5).map((e) => '· ' + e).join('\n')
  return text
}

function registerBackupCommand(ctx, settingsGet) {
  const tryRegister = (cmdName) => ctx.commands.register({
    name: cmdName,
    description: '备份/恢复 DSH 数据。子命令: list | verify [名|latest|all] | restore <名|latest> [--dry-run] [--mode merge|replace] | auto [小时|off|status] | doctor | [--keep N] | help',
    handler: async (invocation) => {
      const input = String((invocation && invocation.rawInput) || '').trim()
      const parts = input.split(/\s+/).filter(Boolean)
      const head = parts[0] || ''
      const reply = (text, kind = 'success') => ({ kind, text })

      try {
        // ---- 立即备份（无参数 / --keep N） ----
        const keepIdx = parts.indexOf('--keep')
        if (head === '' || keepIdx >= 0) {
          if (head !== '' && head !== '--keep' && keepIdx >= 0) {
            return reply(`未知参数：${head}。/backup 直接回车即立即备份。`, 'error')
          }
          const layout = resolveLayout()
          const keepOverride = keepIdx >= 0 ? Number(parts[keepIdx + 1]) : undefined
          const result = await backupToFile({
            layout,
            destination: await destinationOf(settingsGet),
            keep: Number.isFinite(keepOverride) ? keepOverride : settingsGet('keep', 7),
            redactSecrets: settingsGet('redactSecrets', true) !== false,
          })
          let text = `备份完成: ${result.name}\nsha256: ${result.sha256}\n位置: ${result.destination}`
          if (result.redacted.count > 0) text += `\n已脱敏 ${result.redacted.count} 处密钥（恢复时自动保留本机值）`
          if (result.removed.length > 0) text += `\n轮换删除 ${result.removed.length} 份（保留 ${Number.isFinite(keepOverride) ? keepOverride : settingsGet('keep', 7)} 份）`
          return reply(text)
        }

        if (head === 'list' || head === 'ls') {
          const dest = await destinationOf(settingsGet)
          const all = await listBackups(dest)
          const total = all.reduce((s, b) => s + b.size, 0)
          const lines = all.map((b) => `  ${b.name}  ${fmtBytes(b.size)}${b.hasSha256 ? '' : '  （无 .sha256）'}`)
          const auto = await readAutoState(dest)
          const autoText = Number(auto.hours) > 0
            ? `\n自动备份：每 ${auto.hours} 小时（下次 ${autoRuntime.nextRunAt ? autoRuntime.nextRunAt.replace('T', ' ').slice(0, 16) : '重启后调度'}）`
            : '\n自动备份：关闭（/backup auto 12 开启）'
          return reply(all.length
            ? `备份目录: ${dest}\n共 ${all.length} 份 / ${fmtBytes(total)}:\n${lines.join('\n')}${autoText}`
            : `备份目录 ${dest} 为空。输入 /backup 立即备份，或 /backup auto 12 开启自动备份。`)
        }

        if (head === 'verify') {
          const dest = await destinationOf(settingsGet)
          const sel = parts[1] || 'latest'
          const targets = []
          if (sel === 'all') targets.push(...(await listBackups(dest)).map((b) => b.name))
          else if (/^dsh-backup-/.test(sel)) targets.push(sel)
          else {
            const all = await listBackups(dest)
            if (all.length === 0) return reply('备份目录为空，无可校验的备份。')
            targets.push(all[0].name)
          }
          const results = []
          for (const t of targets) {
            try {
              const v = await verifyBackupFile(path.join(dest, t))
              results.push(`${v.ok ? '✅' : '❌'} ${t} — ${v.ok ? `${v.entries} 个条目全部通过 CRC 校验` : `${v.bad.length} 个条目损坏: ${v.bad[0].name}`}`)
            } catch (err) {
              results.push(`❌ ${t} — ${String((err && err.message) || err)}`)
            }
          }
          const bad = results.filter((r) => r.startsWith('❌'))
          return reply(results.join('\n') + (bad.length ? `\n${bad.length} 份校验失败，可删除后重新备份。` : ''), bad.length ? 'error' : 'success')
        }

        if (head === 'restore') {
          const dryRun = parts.includes('--dry-run')
          const modeIdx = parts.indexOf('--mode')
          const mode = modeIdx >= 0 && ['merge', 'replace'].includes(parts[modeIdx + 1]) ? parts[modeIdx + 1] : 'merge'
          const sel = parts.slice(1).find((t) => !t.startsWith('--') && t !== parts[modeIdx + 1]) || 'latest'
          const dest = await destinationOf(settingsGet)
          const target = sel === 'latest'
            ? (await listBackups(dest))[0]
            : (await listBackups(dest)).find((b) => b.name === sel)
          if (!target) return reply(`找不到备份：${sel}。/backup list 查看现有备份。`, 'error')
          const report = await performImport({
            spoolAbs: path.join(dest, target.name),
            layout: resolveLayout(),
            mode,
            components: new Set(COMPONENTS.map((c) => c.id)),
            verify: true,
            res: null,
          })
          let text = `${dryRun ? '【预演】' : ''}来源: ${target.name}\n` + summarizeRestoreReport(report)
          if (dryRun) text = text.replace('导入完成', '预览完成（未写入）').replace('导入完成但有报错', '预览完成（未写入），但有报错')
          return reply(text, report.ok ? 'success' : 'error')
        }

        if (head === 'auto') {
          const arg = parts[1]
          if (!arg || arg === 'status') {
            const dest = await destinationOf(settingsGet)
            const state = await readAutoState(dest)
            const hours = Math.floor(Number(state.hours) || 0)
            return reply(hours > 0
              ? `自动备份：每 ${hours} 小时\n上次: ${state.lastRunAt ? new Date(Number(state.lastRunAt)).toLocaleString() : '尚未运行'}\n下次: ${autoRuntime.nextRunAt ? new Date(autoRuntime.nextRunAt).toLocaleString() : '重启后调度'}\n目录: ${dest}`
              : '自动备份：关闭。/backup auto 12 = 每 12 小时一次（1..720）。')
          }
          if (arg === 'off') {
            const st = await setAutoHours(settingsGet, 0)
            void st
            return reply('自动备份已关闭。')
          }
          const st = await setAutoHours(settingsGet, arg)
          return reply(`自动备份已开启：每 ${st.hours} 小时一次${st.nextRunAt ? `，下次 ${new Date(st.nextRunAt).toLocaleString()}` : ''}。`)
        }

        if (head === 'doctor') {
          const layout = resolveLayout()
          const r = await doctorScan(layout)
          if (r.corrupt.length === 0) {
            return reply(`会话体检：${r.total} 个会话全部健康 ✅`)
          }
          const lines = r.corrupt.slice(0, 10).map((c) => `  · ${c.session}（${c.file || '无会话文件'}）— ${c.reason}`)
          return reply(`会话体检：${r.total} 个会话中 ${r.corrupt.length} 个异常：\n${lines.join('\n')}${r.corrupt.length > 10 ? `\n  … 共 ${r.corrupt.length} 个` : ''}\n\n异常会话仍会照常备份（字节级）；恢复后如打不开，可用更早的备份定点还原。`, 'error')
        }

        if (head === 'help') {
          return reply([
            '/backup —— 立即备份（写 .sha256 + 救援工具到备份目录）',
            '/backup list —— 列出备份',
            '/backup verify [名|latest|all] —— 校验备份完整性',
            '/backup restore <名|latest> [--dry-run] [--mode merge|replace] —— 恢复',
            '/backup auto <小时|off|status> —— 定时自动备份（1..720 小时）',
            '/backup doctor —— 会话日志体检',
            '/backup --keep N —— 本次备份保留 N 份',
          ].join('\n'))
        }

        return reply(`未知子命令：${head}。/backup help 查看用法。`, 'error')
      } catch (err) {
        return reply('失败：' + String((err && err.message) || err), 'error')
      }
    },
  })

  try {
    tryRegister('backup')
  } catch {
    // 命令名被占用（如装了其它 backup 插件）→ 退而注册带前缀的名字
    try { tryRegister('dsh-backup') } catch { /* 命令服务不可用或都冲突：跳过 */ }
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
    backupBusy,
  })
}

async function handleEstimate(res, searchParams) {
  const layout = resolveLayout()
  let ids
  try {
    const set = parseComponents(searchParams) || new Set(COMPONENTS.map((c) => c.id))
    ids = [...set]
  } catch (err) {
    return httpError(res, 400, (err && err.message) || err)
  }
  const estimate = await collectEstimate(layout, ids)
  json(res, 200, { ok: true, ...estimate })
}

// ---------------------------------------------------------------------------
// 插件入口
// ---------------------------------------------------------------------------

export function apply(ctx) {
  let settingsScope = null
  try {
    settingsScope = ctx.settings.register(SETTINGS_NAMESPACE, BackupSettingsSchema, { applies: 'live' })
  } catch (err) { /* 命名空间已注册或设置服务不可用时继续 */ }

  const settingsGet = (field, fallback) => readSettingsGet(settingsScope, field, fallback)

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
        if (isGet && pathname === '/dsh-backup/export') return await handleExport(req, res, searchParams, settingsGet)
        if (isGet && pathname === '/dsh-backup/doctor') return await handleDoctor(res)
        if (isGet && pathname === '/dsh-backup/rescue') return await handleRescueDownload(req, res)

        if (isGet && pathname === '/dsh-backup/disk') {
          const dest = await destinationOf(settingsGet)
          const backups = await listBackups(dest)
          const auto = await readAutoState(dest)
          return json(res, 200, {
            ok: true,
            destination: dest,
            keep: settingsGet('keep', 7),
            redactSecrets: settingsGet('redactSecrets', true) !== false,
            auto: {
              hours: Math.floor(Number(auto.hours) || 0),
              lastRunAt: auto.lastRunAt ? new Date(Number(auto.lastRunAt)).toISOString() : null,
              nextRunAt: autoRuntime.nextRunAt,
            },
            backups,
          })
        }

        if (isGet && pathname === '/dsh-backup/disk/verify') {
          const sel = String(searchParams.get('name') || '')
          if (!/^dsh-backup-\d{8}-\d{6}\.zip$/.test(sel)) return httpError(res, 400, 'name 参数非法')
          const dest = await destinationOf(settingsGet)
          try {
            const v = await verifyBackupFile(path.join(dest, sel))
            return json(res, 200, { ok: true, name: sel, ...v })
          } catch (err) {
            return json(res, 200, { ok: false, name: sel, error: String((err && err.message) || err) })
          }
        }

        if (isPost && pathname === '/dsh-backup/backup-now') {
          try {
            const result = await runBackupNow(settingsGet)
            return json(res, 200, { ok: true, result })
          } catch (err) {
            return httpError(res, 500, String((err && err.message) || err))
          }
        }

        if (isGet && pathname === '/dsh-backup/auto') {
          const dest = await destinationOf(settingsGet)
          const auto = await readAutoState(dest)
          return json(res, 200, {
            ok: true,
            hours: Math.floor(Number(auto.hours) || 0),
            lastRunAt: auto.lastRunAt ? new Date(Number(auto.lastRunAt)).toISOString() : null,
            nextRunAt: autoRuntime.nextRunAt,
            destination: dest,
          })
        }

        if (isPost && pathname === '/dsh-backup/auto') {
          try {
            const st = await setAutoHours(settingsGet, searchParams.get('hours') || '0')
            return json(res, 200, { ok: true, ...st })
          } catch (err) {
            return httpError(res, 400, String((err && err.message) || err))
          }
        }

        if (isPost && pathname === '/dsh-backup/import/execute') {
          // 凭预检 token 复用已落盘的备份包
          const token = String(searchParams.get('token') || '')
          const rec = spoolRegistry.get(token)
          if (!rec) return httpError(res, 409, '预检信息已过期（服务可能重启过），请重新选择文件预检')
          const layout = resolveLayout()
          let mode = String(searchParams.get('mode') || '') || settingsGet('defaultImportMode', 'merge')
          if (mode !== 'merge' && mode !== 'replace') return httpError(res, 400, 'mode 必须是 merge 或 replace')
          const components = parseComponents(searchParams) || new Set(COMPONENTS.map((c) => c.id))
          const verify = searchParams.get('verify') === null
            ? !!settingsGet('verifyChecksums', true)
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
            const components = parseComponents(searchParams) || new Set(COMPONENTS.map((c) => c.id))
            const verify = searchParams.get('verify') === null
              ? !!settingsGet('verifyChecksums', true)
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

  // ---- 斜杠命令（宿主提供 commands 服务时） ----
  try {
    if (ctx.commands && typeof ctx.commands.register === 'function') {
      registerBackupCommand(ctx, settingsGet)
    }
  } catch { /* 命令服务不可用：跳过 */ }

  // ---- 自动备份续跑（重启不中断） ----
  rescheduleAuto(settingsGet).catch(() => {})

  // 周期清理过期 spool（每小时一次足够）
  const timer = setInterval(() => { cleanupSpools().catch(() => {}) }, 60 * 60 * 1000)
  if (typeof timer.unref === 'function') timer.unref()
  cleanupStale(resolveLayout()).catch(() => {})

  ctx.effect(() => () => {
    clearInterval(timer)
    if (autoRuntime.timer) clearTimeout(autoRuntime.timer)
  }, 'dsh-backup: server')
}

export { apply as default, name, inject }
