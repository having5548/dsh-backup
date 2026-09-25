#!/usr/bin/env node
// ============================================================================
// dsh-backup 救援控制台（rescue console）
//
// 用途：DSH 本身起不来时，用普通 Node 直接恢复 dsh-backup 的备份包。
//       每次磁盘备份都会把本文件与双击启动器写进备份目录；也可以从插件
//       仓库 rescue/ 目录单独取用。
//
// 零依赖：只用 node:fs / node:path / node:os / node:zlib / node:readline。
// 用法：
//   node rescue.mjs list   [--dir <备份目录>]
//   node rescue.mjs verify <备份.zip>
//   node rescue.mjs restore <备份.zip> [--dry-run] [--force] [--home <路径>] [--mnemon <路径>]
//   node rescue.mjs help
// 无参数启动 = 交互式菜单（双击启动器走这条路）。
//
// 恢复语义（救援模式，保守优先）：
//   默认只还原「本机不存在」的文件（copy-missing），绝不覆盖已有数据；
//   --force 时覆盖已有文件，原文件先改名 *.bak-rescue-<时间戳> 保留。
//   workspace.json / settings.yaml / mnemon 的 SQLite 库与 wal/shm 按字节
//   还原（SQLite 先清 -wal/-shm 防旧 WAL 配新库）。
// ============================================================================

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import zlib from 'node:zlib'
import readline from 'node:readline'

// ---------------------------------------------------------------------------
// CRC32 + ZIP 读取（内联自 dsh-backup lib/zip.js 的最小子集）
// ---------------------------------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1)
    t[n] = c
  }
  return t
})()

function crc32Of(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

const U32_MAX = 0xFFFFFFFF

class MiniZipReader {
  constructor(absPath) { this.absPath = absPath; this.fd = null; this.entries = [] }

  async open() {
    this.fd = await fs.promises.open(this.absPath, 'r')
    const size = (await this.fd.stat()).size
    const scanWindow = Math.min(size, 22 + 0xFFFF + 64)
    const tail = Buffer.alloc(scanWindow)
    await this.fd.read(tail, 0, scanWindow, size - scanWindow)
    let idx = -1
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) { idx = i; break }
    }
    if (idx < 0) throw new Error('不是有效的 ZIP 文件（找不到 EOCD）')
    const absEocd = size - scanWindow + idx
    let cdOffset = tail.readUInt32LE(idx + 16)
    let cdSize = tail.readUInt32LE(idx + 12)
    if (absEocd >= 20) {
      const loc = Buffer.alloc(20)
      await this.fd.read(loc, 0, 20, absEocd - 20)
      if (loc.readUInt32LE(0) === 0x07064b50) {
        const z64Offset = Number(loc.readBigUInt64LE(8))
        const rec = Buffer.alloc(56)
        await this.fd.read(rec, 0, 56, z64Offset)
        if (rec.readUInt32LE(0) === 0x06064b50) {
          cdSize = Number(rec.readBigUInt64LE(40))
          cdOffset = Number(rec.readBigUInt64LE(48))
        }
      }
    }
    const cd = Buffer.alloc(cdSize)
    await this.fd.read(cd, 0, cdSize, cdOffset)
    this.entries = []
    let p = 0
    while (p + 4 <= cd.length && cd.readUInt32LE(p) === 0x02014b50) {
      const method = cd.readUInt16LE(p + 10)
      const crc = cd.readUInt32LE(p + 16)
      let comp = cd.readUInt32LE(p + 20)
      let uncomp = cd.readUInt32LE(p + 24)
      const nameLen = cd.readUInt16LE(p + 28)
      const extraLen = cd.readUInt16LE(p + 30)
      const commentLen = cd.readUInt16LE(p + 32)
      let lfhOffset = cd.readUInt32LE(p + 42)
      const name = cd.toString('utf8', p + 46, p + 46 + nameLen)
      let q = p + 46 + nameLen
      const qEnd = q + extraLen
      while (q + 4 <= qEnd) {
        const id = cd.readUInt16LE(q)
        const fs2 = cd.readUInt16LE(q + 2)
        if (id === 0x0001) {
          let e = q + 4
          if (uncomp === U32_MAX && e + 8 <= qEnd) { uncomp = Number(cd.readBigUInt64LE(e)); e += 8 }
          if (comp === U32_MAX && e + 8 <= qEnd) { comp = Number(cd.readBigUInt64LE(e)); e += 8 }
          if (lfhOffset === U32_MAX && e + 8 <= qEnd) { lfhOffset = Number(cd.readBigUInt64LE(e)) }
        }
        q += 4 + fs2
      }
      this.entries.push({ name, method, crc, comp, uncomp, lfhOffset })
      p = qEnd + commentLen
    }
    return this.entries
  }

  async readEntry(entry) {
    const lfh = Buffer.alloc(30)
    await this.fd.read(lfh, 0, 30, entry.lfhOffset)
    if (lfh.readUInt32LE(0) !== 0x04034b50) throw new Error(`本地文件头损坏：${entry.name}`)
    const start = entry.lfhOffset + 30 + lfh.readUInt16LE(26) + lfh.readUInt16LE(28)
    const buf = Buffer.alloc(entry.comp)
    await this.fd.read(buf, 0, entry.comp, start)
    let data = buf
    if (entry.method === 8) data = zlib.inflateRawSync(buf)
    else if (entry.method !== 0) throw new Error(`不支持的压缩方法 ${entry.method}：${entry.name}`)
    if (crc32Of(data) !== entry.crc) throw new Error(`CRC 校验失败：${entry.name}`)
    if (data.length !== entry.uncomp) throw new Error(`大小不符：${entry.name}`)
    return data
  }

  async close() { if (this.fd) { await this.fd.close(); this.fd = null } }
}

// ---------------------------------------------------------------------------
// 备份路径映射（与 dsh-backup lib/store.js 的 payload 布局一致）
// ---------------------------------------------------------------------------

function classify(zipPath) {
  const p = zipPath
  if (!p.startsWith('payload/')) return null
  const rest = p.slice('payload/'.length)
  if (rest.startsWith('sessions/')) return { component: 'sessions', rel: rest.slice('sessions/'.length) }
  if (rest.startsWith('sessions-archive/')) return { component: 'sessions', rel: rest.slice('sessions-archive/'.length), archive: true }
  if (rest === 'storages/workspace.json') return { component: 'workspaces', rel: 'workspace.json' }
  if (rest.startsWith('storages/session_projcache/')) return { component: 'projcache', rel: rest.slice('storages/session_projcache/'.length) }
  if (rest.startsWith('attachments/')) return { component: 'attachments', rel: rest.slice('attachments/'.length) }
  if (rest === 'settings/settings.yaml') return { component: 'settings', rel: 'settings.yaml' }
  if (rest.startsWith('profile/')) return { component: 'profile', rel: rest.slice('profile/'.length) }
  if (rest.startsWith('mnemon/')) return { component: 'mnemon', rel: rest.slice('mnemon/'.length) }
  if (rest.startsWith('extensions/')) return { component: 'extensions', rel: rest.slice('extensions/'.length) }
  return null
}

function safeJoin(base, rel) {
  const parts = String(rel).replace(/\\/g, '/').split('/').filter(Boolean)
  if (parts.some((s) => s === '..' || s.includes('\0'))) throw new Error(`路径穿越：${rel}`)
  return path.join(base, ...parts)
}

function destFor(home, mnemonRoot, cls) {
  const join = (...segs) => path.join(home, ...segs)
  switch (cls.component) {
    case 'sessions': return cls.archive ? join('dsh-session-archive', cls.rel) : join('sessions', cls.rel)
    case 'workspaces': return join('storages', 'workspace.json')
    case 'projcache': return join('storages', 'session_projcache', cls.rel)
    case 'attachments': return join('attachments', cls.rel)
    case 'settings': return join('settings.yaml')
    case 'profile': return safeJoin(join('profiles', 'web'), cls.rel)
    case 'mnemon': return safeJoin(mnemonRoot, cls.rel)
    case 'extensions': {
      const segs = cls.rel.split('/')
      const top = segs.shift()
      if (!top || top.startsWith('.')) throw new Error(`extensions 路径非法：${cls.rel}`)
      return path.join(home, top, ...segs)
    }
    default: throw new Error(`未知组件：${cls.component}`)
  }
}

// ---------------------------------------------------------------------------
// 恢复
// ---------------------------------------------------------------------------

function timestampSlug(d = new Date()) {
  const pad = (x) => String(x).padStart(2, '0')
  return '' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds())
}

async function renameWithRetry(src, dest, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try { await fs.promises.rename(src, dest); return } catch (err) {
      if ((err.code === 'EPERM' || err.code === 'EBUSY' || err.code === 'EACCES') && i < tries - 1) {
        await new Promise((r) => setTimeout(r, 250 * (i + 1)))
        continue
      }
      if (err.code === 'EXDEV') {
        const tmp = dest + '.rescue-xdev-' + Math.random().toString(36).slice(2)
        await fs.promises.copyFile(src, tmp)
        try { await fs.promises.rename(tmp, dest); await fs.promises.unlink(src).catch(() => {}); return } catch (e2) {
          await fs.promises.unlink(tmp).catch(() => {}); throw e2
        }
      }
      throw err
    }
  }
}

async function commitStaged(staged, dest, force) {
  await fs.promises.mkdir(path.dirname(dest), { recursive: true })
  let existing = false
  try { await fs.promises.stat(dest); existing = true } catch { /* absent */ }
  if (existing && !force) return { action: 'keptLocal' }
  if (existing) {
    const bak = dest + '.bak-rescue-' + timestampSlug()
    await renameWithRetry(dest, bak)
    try {
      await renameWithRetry(staged, dest)
      return { action: 'replaced', bak }
    } catch (err) {
      await renameWithRetry(bak, dest).catch(() => {})
      throw err
    }
  }
  await renameWithRetry(staged, dest)
  return { action: 'created' }
}

/**
 * 从备份恢复（救援语义：默认 copy-missing；--force 覆盖并留 .bak）。
 * 暂存区放在目标盘内（dshHome / mnemonRoot 下），rename 同卷原子。
 */
export async function rescueRestore(zipAbs, { dryRun = false, force = false, home, mnemonRoot } = {}) {
  home = path.resolve(home || path.join(os.homedir(), '.dsh'))
  mnemonRoot = path.resolve(mnemonRoot || path.join(os.homedir(), '.mnemon'))
  const reader = new MiniZipReader(zipAbs)
  await reader.open()
  try {
    const manifestEntry = reader.entries.find((e) => e.name === 'manifest.json')
    const manifest = manifestEntry ? JSON.parse((await reader.readEntry(manifestEntry)).toString('utf8')) : null
    const plan = { created: [], replaced: [], keptLocal: [], skipped: [] }
    const stagingId = 'dsh-rescue-' + Date.now() + '-' + Math.random().toString(36).slice(2)
    const stageRoots = new Map() // base → staging dir
    let mnemonStagingReady = false

    for (const entry of reader.entries) {
      if (entry.name.endsWith('/')) continue
      const cls = classify(entry.name)
      if (!cls) continue // manifest/checksums/redaction 等元数据
      let dest
      try { dest = destFor(home, mnemonRoot, cls) } catch { plan.skipped.push(entry.name); continue }
      const base = dest.startsWith(mnemonRoot) ? mnemonRoot : home
      if (!stageRoots.has(base)) {
        const stage = path.join(base, '.dsh-backup-staging', stagingId)
        await fs.promises.mkdir(stage, { recursive: true })
        stageRoots.set(base, stage)
      }
      const stage = stageRoots.get(base)
      const staged = path.join(stage, cls.component, cls.rel.replace(/[/\\]/g, '__'))
      await fs.promises.mkdir(path.dirname(staged), { recursive: true })
      const data = await reader.readEntry(entry)
      await fs.promises.writeFile(staged, data)
      let exists = false
      try { await fs.promises.stat(dest); exists = true } catch { /* absent */ }
      if (dryRun) {
        (exists ? (force ? plan.replaced : plan.keptLocal) : plan.created).push(dest)
        continue
      }
      const res = await commitStaged(staged, dest, force)
      if (res.action === 'created') plan.created.push(dest)
      else if (res.action === 'replaced') plan.replaced.push({ dest, bak: res.bak })
      else plan.keptLocal.push(dest)
    }

    if (!dryRun) {
      for (const stage of stageRoots.values()) {
        await fs.promises.rm(path.dirname(stage), { recursive: true, force: true }).catch(() => {})
      }
    }
    return { manifest, plan, home, mnemonRoot }
  } finally {
    await reader.close()
  }
}

// ---------------------------------------------------------------------------
// CLI / 交互
// ---------------------------------------------------------------------------

function fmtBytes(n) {
  if (typeof n !== 'number' || !isFinite(n)) return '—'
  if (n < 1024) return n + ' B'
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB'
  if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB'
  return (n / 1073741824).toFixed(2) + ' GB'
}

function defaultBackupDir() {
  const desktop = path.join(os.homedir(), 'Desktop', 'dsh-backups')
  if (fs.existsSync(path.join(os.homedir(), 'Desktop'))) return desktop
  return path.join(os.homedir(), 'dsh-backups')
}

async function listDir(dir) {
  let items
  try { items = await fs.promises.readdir(dir) } catch { return [] }
  const out = []
  for (const name of items) {
    if (!/^dsh-backup-\d{8}-\d{6}\.zip$/.test(name)) continue
    const stat = await fs.promises.stat(path.join(dir, name)).catch(() => null)
    if (stat) out.push({ name, size: stat.size, mtime: stat.mtime.toISOString() })
  }
  out.sort((a, b) => (a.mtime < b.mtime ? 1 : -1))
  return out
}

async function showManifest(zipAbs) {
  const r = new MiniZipReader(zipAbs)
  await r.open()
  try {
    const me = r.entries.find((e) => e.name === 'manifest.json')
    if (!me) return null
    return JSON.parse((await r.readEntry(me)).toString('utf8'))
  } finally { await r.close() }
}

function printHelp() {
  console.log([
    '',
    'dsh-backup 救援控制台 —— DSH 起不来也能恢复备份',
    '',
    '用法:',
    '  node rescue.mjs list                       列出备份（默认目录，可用 --dir 指定）',
    '  node rescue.mjs verify <备份.zip>          校验一个备份的完整性（逐条目 CRC）',
    '  node rescue.mjs restore <备份.zip|latest>  恢复（默认只补缺失文件，绝不覆盖）',
    '      --force                                覆盖已有文件（原文件保留 *.bak-rescue-*）',
    '      --dry-run                              只预览将发生什么，不写入',
    '      --dir <备份目录>                       查找 latest 的目录',
    '      --home <路径> --mnemon <路径>          覆盖目标目录（默认 ~/.dsh 与 ~/.mnemon）',
    '  node rescue.mjs help                       本帮助',
    '',
    '无参数启动 = 交互式菜单。',
    '',
  ].join('\n'))
}

async function pickLatest(dir) {
  const all = await listDir(dir)
  if (all.length === 0) throw new Error('备份目录里没有备份：' + dir)
  return path.join(dir, all[0].name)
}

async function main() {
  const argv = process.argv.slice(2)
  const flag = (name) => argv.includes(name)
  const val = (name) => {
    const i = argv.indexOf(name)
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null
  }
  const cmd = argv.find((a, i) => i === 0 && !a.startsWith('--')) || ''
  const dir = val('--dir') || defaultBackupDir()

  if (!cmd || cmd === 'help') {
    printHelp()
    if (!cmd) await interactive(dir)
    return
  }

  if (cmd === 'list') {
    const all = await listDir(dir)
    if (all.length === 0) { console.log('（' + dir + '）里没有备份'); return }
    console.log(`备份目录：${dir}`)
    for (const b of all) {
      let note = ''
      try {
        const m = await showManifest(path.join(dir, b.name))
        if (m) note = `  会话 ${m.counts && m.counts.sessionDirs} · 工作区 ${m.counts && m.counts.workspaces} · ${m.createdAt ? m.createdAt.slice(0, 16).replace('T', ' ') : ''}`
      } catch { note = '  ⚠ manifest 读取失败' }
      console.log(`  ${b.name}  ${fmtBytes(b.size)}${note}`)
    }
    return
  }

  if (cmd === 'verify') {
    const target = argv[1] && argv[1] !== '--dir' ? argv[1] : null
    const zipAbs = target && /^dsh-backup-/.test(target) ? path.join(dir, target) : target
    if (!zipAbs) { console.error('用法: node rescue.mjs verify <备份.zip>'); process.exitCode = 1; return }
    const r = new MiniZipReader(zipAbs)
    const entries = await r.open()
    let bad = 0
    for (const e of entries) {
      try { await r.readEntry(e) } catch (err) { bad++; console.log('  ❌', e.name, '—', err.message) }
    }
    await r.close()
    console.log(bad === 0 ? `✅ ${path.basename(zipAbs)}：${entries.length} 个条目全部通过 CRC 校验` : `❌ ${bad}/${entries.length} 个条目损坏`)
    if (bad > 0) process.exitCode = 1
    return
  }

  if (cmd === 'restore') {
    let target = argv[1] && !argv[1].startsWith('--') ? argv[1] : null
    if (!target || target === 'latest') target = await pickLatest(dir)
    const zipAbs = /^([a-zA-Z]:)?[\\/]/.test(target) ? target : path.join(dir, target)
    const dryRun = flag('--dry-run')
    const force = flag('--force')
    console.log(`备份：${zipAbs}`)
    console.log(`目标：~/.dsh 与 ~/.mnemon${dryRun ? '（预演，不写入）' : ''} · 模式：${force ? '覆盖（留 .bak）' : '只补缺失文件'}`)
    const r = await rescueRestore(zipAbs, {
      dryRun, force,
      home: val('--home') || undefined,
      mnemonRoot: val('--mnemon') || undefined,
    })
    console.log(`  还原文件 ${r.plan.created.length} 个，覆盖 ${r.plan.replaced.length} 个，保留本机 ${r.plan.keptLocal.length} 个，跳过 ${r.plan.skipped.length} 个`)
    if (r.plan.replaced.length) {
      console.log('  被覆盖的原文件：')
      for (const x of r.plan.replaced.slice(0, 10)) console.log('   ·', x.bak)
      if (r.plan.replaced.length > 10) console.log(`   … 共 ${r.plan.replaced.length} 个`)
    }
    console.log(dryRun ? '预演完成（未写入）。去掉 --dry-run 执行真正恢复。' : '恢复完成。装好 dsh 后启动即可。')
    return
  }

  printHelp()
  process.exitCode = 1
}

async function interactive(dir) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  const ask = (q) => new Promise((res) => rl.question(q, res))
  try {
    for (;;) {
      const all = await listDir(dir)
      console.log(`\n=== dsh-backup 救援控制台 ===\n备份目录：${dir}`)
      if (all.length === 0) console.log('（目录里没有备份）')
      all.slice(0, 9).forEach((b, i) => console.log(`  ${i + 1}. ${b.name}  ${fmtBytes(b.size)}`))
      console.log('  l. 刷新   h. 帮助   q. 退出')
      const ans = (await ask('选择要恢复的编号（或命令）：')).trim()
      if (ans === 'q' || ans === '') break
      if (ans === 'l') continue
      if (ans === 'h') { printHelp(); continue }
      const n = Number(ans)
      if (!Number.isInteger(n) || n < 1 || n > all.length) { console.log('无效选择'); continue }
      const zipAbs = path.join(dir, all[n - 1].name)
      const mode = (await ask('模式：【1】只补缺失文件（安全，默认）  【2】覆盖已有文件（留 .bak）  【3】先预览：')).trim() || '1'
      const r = await rescueRestore(zipAbs, { dryRun: mode === '3', force: mode === '2' }).catch((err) => { console.error('恢复失败：', err.message); return null })
      if (r) {
        console.log(`  还原 ${r.plan.created.length} · 覆盖 ${r.plan.replaced.length} · 保留本机 ${r.plan.keptLocal.length}`)
        console.log(mode === '3' ? '预演完成（未写入）。' : '恢复完成。装好 dsh 后启动即可。')
      }
    }
  } finally {
    rl.close()
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
if (isMain || process.argv[1]?.toLowerCase().endsWith('rescue.mjs')) {
  main().catch((err) => {
    console.error('错误：', err && err.message ? err.message : err)
    process.exitCode = 1
  })
}
