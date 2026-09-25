// ============================================================================
// dsh-backup 离线测试（node --test，零依赖，不需要 schemastery / dsh 环境）
//
// 覆盖：
//   1. ZIP 写读回环（文本/二进制/空文件/嵌套目录/大文件 + CRC 校验）
//   2. zip 路径安全（穿越 / 绝对路径 / 驱动器号）
//   3. 组件分类与落点映射（会话 vs 归档 / workspace 特例 / extensions 隔离）
//   4. workspace.json 合并语义（新者胜 / 保序 / pendingMutation 保留本机）
//   5. memories.json 合并语义（target+content 去重）
//   6. documents/index.json 合并语义（同 id 同 hash 跳过 / 同 id 异 hash 换新 id）
//   7. 端到端：造两套假 dsh home → 导出 → 合并导入 / 覆盖导入 → 逐字节断言
//      （含 mnemon 三目录、SQLite 库替换、wal/shm 清理、settings.yaml .bak）
// ============================================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

import { ZipWriter, ZipReader, sanitizeZipName, crc32 } from '../lib/zip.js'
import {
  FORMAT_VERSION, resolveLayout, collectExportFiles, buildManifest,
  classifyZipPath, destForComponent, mergeWorkspaceRegistries,
  mergeMemoriesJson, mergeDocumentsIndex, planImport, extractPayload,
  applyImport, cleanupStale, COMPONENTS,
} from '../lib/store.js'
// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dshb-test-'))
}

function write(abs, content) {
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content)
  return abs
}

const SQLITE_HEADER = Buffer.concat([Buffer.from('SQLite format 3\0'), crypto.randomBytes(64)])

function makeFakeHome(root, name) {
  const home = path.join(root, name)
  const mnemon = path.join(root, name + '-mnemon')
  process.env.DSH_HOME = home
  process.env.MNEMON_DATA_DIR = mnemon

  const sessions = path.join(home, 'sessions', '--H-demo--')
  const s1 = write(path.join(sessions, '11111111-1111-4111-8111-111111111111', 'session.v3.jsonl.zstd'), Buffer.concat([Buffer.from('S1V3:'), crypto.randomBytes(64)]))
  const s2 = write(path.join(sessions, '22222222-2222-4222-8222-222222222222', 'session.v2.jsonl'), 'S2V2: 旧代际会话,字节级原样')
  write(path.join(home, 'dsh-session-archive', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'session.v3.jsonl.zstd'), 'ARCHIVE1')
  const workspaceJson = write(path.join(home, 'storages', 'workspace.json'), JSON.stringify({
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, workspaceIds: ['w-local'], archivedSessionIds: ['session-a'] },
    tables: { workspaces: { 'w-local': { path: 'C:\\demo', title: 'demo', sessionIds: ['session-1'], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z' } } },
  }))
  const proj = write(path.join(home, 'storages', 'session_projcache', '11111111-1111-4111-8111-111111111111.json'), '{"cached":true}')
  const att = write(path.join(home, 'attachments', 'img.bin'), crypto.randomBytes(256))
  const settingsYaml = write(path.join(home, 'settings.yaml'), 'ui-onboarding:\n  done: true\n')
  write(path.join(home, 'profiles', 'web', 'package.json'), JSON.stringify({
    name: 'dsh-profile-web',
    dependencies: { 'dsh-notify': 'file:../dsh-notify.tgz' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-notify'] } },
  }))
  write(path.join(home, 'profiles', 'web', 'cordis.patch.yml'), '[]\n')
  write(path.join(home, 'profiles', 'web', 'cordis.yml'), '[]\n')
  // 其他插件数据（extensions 动态组件）
  const ext = write(path.join(home, 'task-board', 'ledger.json'), '{"local":"B"}')

  write(path.join(mnemon, 'runtime', 'memories.json'), JSON.stringify({ version: 1, entries: [
    { content: '本地记忆A', created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', target: 'memory', importance: 'normal' },
    { content: '共有记忆', created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', target: 'memory', importance: 'normal' },
  ] }))
  const memoryMd = write(path.join(mnemon, 'runtime', 'MEMORY.md'), '# MEMORY\n§ 本地记忆A\n')
  write(path.join(mnemon, 'runtime', 'USER.md'), '# USER\n')
  const docId1 = '11111111-1111-4111-8111-111111111111'
  write(path.join(mnemon, 'documents', 'active', 'doc-a-' + docId1.slice(0, 8) + '.md'), '---\nid: "' + docId1 + '"\ntitle: A\n---\n内容A')
  write(path.join(mnemon, 'documents', 'index.json'), JSON.stringify({ version: 1, documents: [
    { id: docId1, title: 'A', description: '', status: 'active', filename: 'doc-a-' + docId1.slice(0, 8) + '.md', relativePath: 'documents/active/doc-a-' + docId1.slice(0, 8) + '.md', sourcePaths: [], sessionIds: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', lastAccessedAt: '2026-01-01T00:00:00.000Z', revision: 1, contentHash: 'hash-a', sizeBytes: 10, memoryBodyIds: [] },
  ] }))
  write(path.join(mnemon, 'data', '.dsh-memory-bodies.json'), JSON.stringify({ version: 1, bodies: [
    { id: 'default', name: 'default', description: '', active: true, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
  ] }))
  const db = write(path.join(mnemon, 'data', 'default', 'mnemon.db'), SQLITE_HEADER)

  return {
    root, home, mnemon,
    p: { sessions, s1, s2, workspaceJson, proj, att, settingsYaml, ext, memoryMd, db },
  }
}

/** 导出 → zip Buffer（与 index.js handleExport 同一条代码路径）。 */
async function exportBackup(layout, componentIds) {
  const components = new Set(componentIds)
  const { files, componentStats } = await collectExportFiles(layout, components)
  const manifest = await buildManifest(layout, [...components], componentStats)
  const chunks = []
  const sink = { async write(c) { chunks.push(c) } }
  const writer = new ZipWriter(sink)
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2), 'utf8')
  const h = crypto.createHash('sha256')
  h.update(manifestBytes)
  const checksums = { algorithm: 'zip-entry-crc32 + manifest-sha256', manifest: h.digest('hex'), files: {} }
  for (const f of files) checksums.files[f.zipPath] = { size: f.size }
  await writer.addBuffer('manifest.json', manifestBytes)
  for (const f of files) await writer.addFromFile(f.abs, f.zipPath, { mtime: f.mtime })
  await writer.addBuffer('checksums.json', Buffer.from(JSON.stringify(checksums, null, 2), 'utf8'))
  await writer.close()
  return { zip: Buffer.concat(chunks), manifest }
}

/** 打开备份（与 index.js openBackup 等价的测试版）。 */
async function openBackupTest(abs) {
  const reader = new ZipReader(abs)
  await reader.open()
  const manifestEntry = reader.entries.find((e) => e.name === 'manifest.json')
  assert.ok(manifestEntry, 'manifest.json 缺失')
  const manifest = JSON.parse((await reader.readEntry(manifestEntry)).toString('utf8'))
  assert.equal(manifest.format, 'dsh-backup')
  assert.equal(manifest.formatVersion, FORMAT_VERSION)
  let checksums = null
  const ce = reader.entries.find((e) => e.name === 'checksums.json')
  if (ce) checksums = JSON.parse((await reader.readEntry(ce)).toString('utf8'))
  return { reader, manifest, checksums }
}

async function importBackup(zipBuf, layout, mode, componentIds, { corruptSize } = {}) {
  const abs = path.join(layout.dshHome, '..')
  const backupFile = path.join(abs, 'backup-' + crypto.randomBytes(4).toString('hex') + '.zip')
  fs.writeFileSync(backupFile, zipBuf)
  const { reader, manifest, checksums } = await openBackupTest(backupFile)
  try {
    if (corruptSize && checksums) {
      const key = Object.keys(checksums.files).find((k) => k.startsWith('payload/sessions/'))
      assert.ok(key)
      checksums.files[key] = { size: checksums.files[key].size + 1 }
    }
    const components = new Set(componentIds)
    const plan = await planImport(reader, { layout, mode, components, manifest, checksums })
    if (corruptSize) {
      await assert.rejects(
        () => extractPayload(reader, reader.entries, layout, checksums, true),
        /sha256|大小|损坏|校验|size/i,
      )
      return { plan, report: null }
    }
    const { stagingRootDsh, stagingRootMnemon, extracted } = await extractPayload(reader, reader.entries, layout, checksums, true)
    let report
    try {
      report = await applyImport(reader, { layout, mode, components, manifest, extracted, plan })
    } finally {
      fs.rmSync(stagingRootDsh, { recursive: true, force: true })
      fs.rmSync(stagingRootMnemon, { recursive: true, force: true })
    }
    return { plan, report }
  } finally {
    await reader.close()
    fs.unlinkSync(backupFile)
  }
}

const ALL = COMPONENTS.map((c) => c.id)

// ---------------------------------------------------------------------------
// 1. ZIP 回环
// ---------------------------------------------------------------------------

test('zip 回环：文本/二进制/空文件/嵌套目录/大文件', async () => {
  const dir = tmpRoot()
  try {
    const big = crypto.randomBytes(3 * 1024 * 1024)
    const files = [
      ['a.txt', Buffer.from('hello 世界'), false],
      ['nested/dir/b.json', Buffer.from('{"ok":true}'), false],
      ['bin/db.sqlite', SQLITE_HEADER, true],
      ['empty.txt', Buffer.alloc(0), false],
      ['big.bin', big, true],
      ['small-but-deflates-bigger.bin', Buffer.from('x'), false],
    ]
    for (const [rel, content] of files) write(path.join(dir, rel), content)

    const chunks = []
    const writer = new ZipWriter({ async write(c) { chunks.push(c) } })
    for (const [rel, , storeMode] of files) {
      await writer.addFromFile(path.join(dir, rel), 'payload/' + rel, { store: storeMode })
    }
    await writer.close()
    const zipBuf = Buffer.concat(chunks)
    fs.writeFileSync(path.join(dir, 'out.zip'), zipBuf)

    const reader = new ZipReader(path.join(dir, 'out.zip'))
    const entries = await reader.open()
    assert.equal(entries.length, files.length)
    for (const [rel, content] of files) {
      const entry = entries.find((e) => e.name === 'payload/' + rel)
      assert.ok(entry, '缺少条目 ' + rel)
      const got = await reader.readEntry(entry)
      assert.ok(got.equals(content), '内容不一致：' + rel)
    }
    await reader.close()
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('zip 回环：reader 对 Windows 资源管理器风格 zip（store 模式、目录占位条目）', async () => {
  const dir = tmpRoot()
  try {
    // 手工构造一个最小 zip：目录条目 + 一个 store 文件（模拟第三方工具产物）
    const name = Buffer.from('payload/flat.txt')
    const data = Buffer.from('plain')
    const lfh = Buffer.alloc(30)
    lfh.writeUInt32LE(0x04034b50, 0)
    lfh.writeUInt16LE(20, 4)
    lfh.writeUInt16LE(0, 6)
    lfh.writeUInt16LE(0, 8) // store
    lfh.writeUInt16LE(0, 26); lfh.writeUInt16LE(name.length, 28)
    const c = crc32(); c.update(data)
    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0)
    cd.writeUInt16LE(20, 6)
    cd.writeUInt16LE(0, 8); cd.writeUInt16LE(0, 10)
    cd.writeUInt32LE(c.digest(), 16)
    cd.writeUInt32LE(data.length, 20); cd.writeUInt32LE(data.length, 24)
    cd.writeUInt16LE(name.length, 28)
    cd.writeUInt32LE(0, 42) // LFH offset
    const dataStart = 30 + name.length
    const cdStart = dataStart + data.length
    const cdSize = 46 + name.length
    const eocd = Buffer.alloc(22)
    eocd.writeUInt32LE(0x06054b50, 0)
    eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10)
    eocd.writeUInt32LE(cdSize, 12) // CD 大小（记录 + 名字）
    eocd.writeUInt32LE(cdStart, 16) // CD 起始
    const zipBuf = Buffer.concat([lfh, name, data, cd, name, eocd])
    const zipPath = path.join(dir, 'ext.zip')
    fs.writeFileSync(zipPath, zipBuf)

    const reader = new ZipReader(zipPath)
    const entries = await reader.open()
    assert.equal(entries.length, 1)
    assert.equal((await reader.readEntry(entries[0])).toString(), 'plain')
    await reader.close()
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 2. 路径安全
// ---------------------------------------------------------------------------

test('zip 路径安全：拒绝穿越/绝对路径/驱动器号', () => {
  assert.throws(() => sanitizeZipName('../evil.txt'), /穿越/)
  assert.throws(() => sanitizeZipName('payload/../../evil.txt'), /穿越/)
  assert.throws(() => sanitizeZipName('/abs.txt'), /非法/)
  assert.throws(() => sanitizeZipName('C:/abs.txt'), /非法/)
  assert.throws(() => sanitizeZipName('bad\0name.txt'), /空字节|非法|穿越/)
  assert.equal(sanitizeZipName('payload/a/b.txt'), 'payload/a/b.txt')
  assert.equal(sanitizeZipName('payload\\win\\path.txt'), 'payload/win/path.txt')
})

// ---------------------------------------------------------------------------
// 3. 分类与落点
// ---------------------------------------------------------------------------

test('组件分类与落点：归档会话进 dsh-session-archive，extensions 顶层隔离', () => {
  const root = tmpRoot()
  try {
    process.env.DSH_HOME = path.join(root, 'h')
    process.env.MNEMON_DATA_DIR = path.join(root, 'h-mnemon')
    const layout = resolveLayout()

    const cases = [
      ['payload/sessions/--H-demo--/x/session.v3.jsonl.zstd', { component: 'sessions' }, path.join(layout.p.sessions, '--H-demo--', 'x', 'session.v3.jsonl.zstd')],
      ['payload/sessions-archive/aaa/session.v3.jsonl.zstd', { component: 'sessions' }, path.join(layout.p.archive, 'aaa', 'session.v3.jsonl.zstd')],
      ['payload/storages/workspace.json', { component: 'workspaces' }, layout.p.workspaceJson],
      ['payload/storages/session_projcache/a.json', { component: 'projcache' }, path.join(layout.p.projcache, 'a.json')],
      ['payload/attachments/a.bin', { component: 'attachments' }, path.join(layout.p.attachments, 'a.bin')],
      ['payload/settings/settings.yaml', { component: 'settings' }, layout.p.settingsYaml],
      ['payload/profile/package.json', { component: 'profile' }, path.join(layout.profileDir, 'package.json')],
      ['payload/mnemon/runtime/memories.json', { component: 'mnemon' }, path.join(layout.mnemonRoot, 'runtime', 'memories.json')],
    ]
    for (const [zipPath, expectComponent, expectDest] of cases) {
      const cls = classifyZipPath(zipPath)
      assert.equal(cls.component, expectComponent.component, zipPath)
      assert.equal(destForComponent(layout, cls), expectDest, zipPath)
    }

    const ext = classifyZipPath('payload/extensions/task-board/ledger.json')
    assert.equal(ext.component, 'extensions')
    assert.equal(destForComponent(layout, ext), path.join(layout.dshHome, 'task-board', 'ledger.json'))
    assert.throws(() => destForComponent(layout, { component: 'extensions', rel: '.ssh/id_rsa' }), /非法/)

    assert.equal(classifyZipPath('payload/future-component/x.bin').kind, 'unknown')
    assert.equal(classifyZipPath('manifest.json').kind, 'meta')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 4. workspace.json 合并
// ---------------------------------------------------------------------------

test('workspace 合并：新者胜 / 保序去重 / pendingMutation 保留本机 / 本机版本优先', () => {
  const local = {
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, workspaceIds: ['w1', 'w2'], archivedSessionIds: ['s1'], pendingMutation: { operation: 'create', workspaceId: 'w9' } },
    tables: { workspaces: {
      w1: { path: 'C:\\a', title: 'a', sessionIds: ['s1'], createdAt: 'T0', updatedAt: '2026-01-01T00:00:00.000Z' },
      w2: { path: 'C:\\b', title: 'b', sessionIds: [], createdAt: 'T0', updatedAt: 'T0' },
    } },
  }
  const backup = {
    unit: { name: 'workspace', version: 3 }, // 更新版本的备份：结构仍以本机为准
    global: { initialized: true, workspaceIds: ['w1', 'w3'], archivedSessionIds: ['s1', 's2'] },
    tables: { workspaces: {
      w1: { path: 'C:\\a', title: 'a2', sessionIds: ['s1', 's9'], createdAt: 'T0', updatedAt: '2026-06-01T00:00:00.000Z' }, // 更新 → 采用备份
      w3: { path: 'C:\\c', title: 'c', sessionIds: [], createdAt: 'T0', updatedAt: 'T0' }, // 新增
      w4: { path: 'C:\\d', title: 'd', sessionIds: [], createdAt: 'T0', updatedAt: '2026-02-01T00:00:00.000Z' }, // 只在备份 → 新增
    } },
  }
  const { result, added, updated, kept } = mergeWorkspaceRegistries(local, backup)
  assert.equal(result.unit.version, 2)
  assert.deepEqual(result.global.workspaceIds, ['w1', 'w2', 'w3', 'w4'])
  assert.deepEqual(result.global.archivedSessionIds, ['s1', 's2'])
  assert.equal(result.global.pendingMutation.operation, 'create') // 本机在途日志保留
  assert.equal(result.tables.workspaces.w1.title, 'a2')
  assert.equal(result.tables.workspaces.w2.title, 'b')
  assert.ok(result.tables.workspaces.w3 && result.tables.workspaces.w4)
  assert.equal(added, 2)
  assert.equal(updated, 1)
  assert.equal(kept, 1)

  // 本机无文件：全新恢复
  const fresh = mergeWorkspaceRegistries(null, backup)
  assert.equal(fresh.result.unit.version, 3)
  assert.equal(Object.keys(fresh.result.tables.workspaces).length, 3)
})

// ---------------------------------------------------------------------------
// 5. memories 合并
// ---------------------------------------------------------------------------

test('memories 合并：按 target+content 去重、保序', () => {
  const local = { version: 1, entries: [
    { content: 'A', target: 'memory' },
    { content: '共享', target: 'memory' },
    { content: '用户档案', target: 'user' },
  ] }
  const backup = { version: 1, entries: [
    { content: '共享', target: 'memory' }, // 重复 → 跳过
    { content: 'A', target: 'user' },      // target 不同 → 保留
    { content: '备份新增', target: 'memory' },
  ] }
  const { json, added, total } = mergeMemoriesJson(local, backup)
  assert.equal(added, 2)
  assert.equal(total, 5)
  assert.deepEqual(json.entries.map((e) => e.content + ':' + e.target), ['A:memory', '共享:memory', '用户档案:user', 'A:user', '备份新增:memory'])
})

// ---------------------------------------------------------------------------
// 6. documents 合并
// ---------------------------------------------------------------------------

test('documents 合并：同 id 同 hash 跳过 / 同 id 异 hash 换新 id / 新 id 导入 / 文件名冲突', () => {
  const local = { version: 1, documents: [
    { id: 'd1', title: 'same', filename: 'same-aaaaaaaa.md', relativePath: 'documents/active/same-aaaaaaaa.md', status: 'active', contentHash: 'h1' },
    { id: 'd2', title: 'changed', filename: 'changed-bbbbbbbb.md', relativePath: 'documents/active/changed-bbbbbbbb.md', status: 'active', contentHash: 'old' },
  ] }
  const backup = { version: 1, documents: [
    { id: 'd1', title: 'same', filename: 'same-aaaaaaaa.md', relativePath: 'documents/active/same-aaaaaaaa.md', status: 'active', contentHash: 'h1' }, // 跳过
    { id: 'd2', title: 'changed', filename: 'changed-bbbbbbbb.md', relativePath: 'documents/active/changed-bbbbbbbb.md', status: 'active', contentHash: 'new' }, // 同 id 异内容 → 换新 id
    { id: 'd3', title: 'new', filename: 'new-cccccccc.md', relativePath: 'documents/active/new-cccccccc.md', status: 'active', contentHash: 'h3' }, // 新增
  ] }
  const { index, ops, added, renamed, skipped } = mergeDocumentsIndex(local, backup)
  assert.equal(skipped, 1)
  assert.equal(renamed, 1)
  assert.equal(added, 2)
  assert.equal(index.documents.length, 4)
  const d2New = index.documents.find((d) => d.title === 'changed' && d.id !== 'd2')
  assert.ok(d2New, '同 id 异内容应换新 id')
  assert.notEqual(d2New.filename, 'changed-bbbbbbbb.md')
  assert.match(d2New.filename, /^changed-[0-9a-f]{8}\.md$/)
  const renameOp = ops.find((o) => o.kind === 'rename')
  assert.ok(renameOp)
  assert.equal(renameOp.to, d2New.filename)
})

// ---------------------------------------------------------------------------
// 7. 端到端
// ---------------------------------------------------------------------------

test('端到端：导出（含 extensions/mnemon）→ 合并导入到另一套 home', async () => {
  const root = tmpRoot()
  const prevHome = process.env.DSH_HOME
  const prevMnemon = process.env.MNEMON_DATA_DIR
  try {
    const a = makeFakeHome(root, 'home-a')
    const layoutA = resolveLayout()
    const { zip, manifest } = await exportBackup(layoutA, ALL)

    // manifest 概况
    assert.equal(manifest.counts.sessionDirs, 2)
    assert.equal(manifest.counts.workspaces, 1)
    assert.ok(manifest.components.mnemon.included && manifest.components.mnemon.files > 0)
    assert.ok(manifest.components.extensions.included && manifest.components.extensions.files > 0)

    // 造目标 home B：与 A 部分重叠
    process.env.DSH_HOME = path.join(root, 'home-b')
    process.env.MNEMON_DATA_DIR = path.join(root, 'home-b-mnemon')
    const b = makeFakeHome(root, 'home-b')
    // B 的 s1 与 A 内容不同（合并模式应保留 B）
    fs.writeFileSync(b.p.s1, Buffer.from('B-LOCAL-S1'))
    // 删掉 B 的 s2 会话与归档会话（导入后应从 A 补回）
    fs.rmSync(path.join(b.home, 'sessions', '--H-demo--', '22222222-2222-4222-8222-222222222222'), { recursive: true, force: true })
    fs.rmSync(path.join(b.home, 'dsh-session-archive'), { recursive: true, force: true })
    // B 的 mnemon 多一条本地记忆、少一个文档
    const bMemPath = path.join(b.mnemon, 'runtime', 'memories.json')
    const bMem = JSON.parse(fs.readFileSync(bMemPath, 'utf8'))
    bMem.entries.push({ content: 'B独有', target: 'memory' })
    fs.writeFileSync(bMemPath, JSON.stringify(bMem))
    const layoutB = resolveLayout()

    const { plan, report } = await importBackup(zip, layoutB, 'merge', ALL)
    assert.ok(report, '应有报告')
    assert.ok(report.ok, '导入应无错误：' + JSON.stringify(report.errors))

    // sessions：s2 + 归档会话补回（字节一致），s1 内容不同 → 保留 B
    assert.equal(report.components.sessions.add, 2)
    assert.equal(report.components.sessions.skip, 1)
    const s2b = path.join(layoutB.p.sessions, '--H-demo--', '22222222-2222-4222-8222-222222222222', 'session.v2.jsonl')
    assert.equal(fs.readFileSync(s2b, 'utf8'), 'S2V2: 旧代际会话,字节级原样')
    assert.equal(fs.readFileSync(b.p.s1, 'utf8'), 'B-LOCAL-S1')

    // workspace：B 获得 A 的工作区（同 id updatedAt 相同 → 保留 B 记录，但 w-local 已存在；A 与 B 同 id）
    assert.equal(report.components.workspaces.action, 'merged')
    const wb = JSON.parse(fs.readFileSync(layoutB.p.workspaceJson, 'utf8'))
    assert.equal(wb.unit.version, 2)
    assert.ok(wb.tables.workspaces['w-local'])
    assert.deepEqual(wb.global.archivedSessionIds.sort(), ['session-a'])

    // mnemon：memories 并入 2 条（A 的 本地记忆A/共有记忆 中，共有记忆重复 → 只并入 1 条？B 已有 共有记忆 + 本地记忆A + B独有）
    // A memories = [本地记忆A, 共有记忆]；B = [本地记忆A, 共有记忆, B独有] → added = 0
    assert.equal(report.mnemon.memoriesAdded, 0)
    assert.equal(fs.readFileSync(b.p.memoryMd, 'utf8'), '# MEMORY\n§ 本地记忆A\n') // 投影保留本机
    // documents：同 id 同 hash → 跳过
    assert.equal(report.mnemon.documentsSkipped, 1)
    assert.equal(report.mnemon.documentsAdded, 0)
    // bodies：A 与 B 都只有 default → 保留
    assert.equal(report.mnemon.bodiesKept >= 1, true)
    const dbB = fs.readFileSync(path.join(layoutB.mnemonRoot, 'data', 'default', 'mnemon.db'))
    assert.ok(dbB.slice(0, 16).toString().startsWith('SQLite format 3'))

    // extensions：B 已有 task-board/ledger.json（内容不同）→ 合并保留 B
    assert.equal(fs.readFileSync(b.p.ext, 'utf8'), '{"local":"B"}')

    // settings：合并模式跳过
    assert.equal(report.components.settings.action, 'skippedMergeMode')
    assert.equal(fs.readFileSync(b.p.settingsYaml, 'utf8'), 'ui-onboarding:\n  done: true\n')
  } finally {
    process.env.DSH_HOME = prevHome
    process.env.MNEMON_DATA_DIR = prevMnemon
    fs.rmSync(root, { recursive: true, force: true })
  }
})


test('端到端：全新 home 覆盖导入 → 会话/工作区/设置/mnemon 全量还原', async () => {
  const root = tmpRoot()
  const prevHome = process.env.DSH_HOME
  const prevMnemon = process.env.MNEMON_DATA_DIR
  try {
    const a = makeFakeHome(root, 'home-a')
    const layoutA = resolveLayout()
    const { zip } = await exportBackup(layoutA, ALL)

    // 全新目标：空 home + 空 mnemon
    process.env.DSH_HOME = path.join(root, 'home-fresh')
    process.env.MNEMON_DATA_DIR = path.join(root, 'home-fresh-mnemon')
    fs.mkdirSync(path.join(root, 'home-fresh'), { recursive: true })
    const layoutF = resolveLayout()

    const { report } = await importBackup(zip, layoutF, 'replace', ALL)
    assert.ok(report.ok, '导入应无错误：' + JSON.stringify(report.errors))

    // 会话字节级一致
    const s1f = path.join(layoutF.p.sessions, '--H-demo--', '11111111-1111-4111-8111-111111111111', 'session.v3.jsonl.zstd')
    assert.ok(fs.readFileSync(s1f).equals(fs.readFileSync(a.p.s1)), 's1 应字节一致')
    const s2f = path.join(layoutF.p.sessions, '--H-demo--', '22222222-2222-4222-8222-222222222222', 'session.v2.jsonl')
    assert.equal(fs.readFileSync(s2f, 'utf8'), fs.readFileSync(a.p.s2, 'utf8'))
    // 归档会话
    assert.ok(fs.existsSync(path.join(layoutF.p.archive, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'session.v3.jsonl.zstd')))
    // 工作区注册表原样
    const wf = JSON.parse(fs.readFileSync(layoutF.p.workspaceJson, 'utf8'))
    assert.equal(wf.global.workspaceIds[0], 'w-local')
    assert.equal(report.components.workspaces.action, 'replaced')
    // 设置替换 + .bak（全新 home 无原文件 → created）
    assert.equal(fs.readFileSync(layoutF.p.settingsYaml, 'utf8'), 'ui-onboarding:\n  done: true\n')
    // mnemon 全还原
    assert.ok(fs.readFileSync(path.join(layoutF.mnemonRoot, 'runtime', 'MEMORY.md'), 'utf8').includes('本地记忆A'))
    const mem = JSON.parse(fs.readFileSync(path.join(layoutF.mnemonRoot, 'runtime', 'memories.json'), 'utf8'))
    assert.equal(mem.entries.length, 2)
    assert.ok(fs.readFileSync(path.join(layoutF.mnemonRoot, 'data', 'default', 'mnemon.db')).equals(SQLITE_HEADER))
    assert.equal(report.mnemon.dbReplaced, 1)
    // extensions
    assert.equal(fs.readFileSync(path.join(layoutF.dshHome, 'task-board', 'ledger.json'), 'utf8'), '{"local":"B"}')
    assert.ok(report.needsRestart)

  } finally {
    process.env.DSH_HOME = prevHome
    process.env.MNEMON_DATA_DIR = prevMnemon
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('端到端：覆盖导入替换已有数据并留 .bak，且清掉与新库不匹配的 wal/shm', async () => {
  const root = tmpRoot()
  const prevHome = process.env.DSH_HOME
  const prevMnemon = process.env.MNEMON_DATA_DIR
  try {
    const a = makeFakeHome(root, 'home-a')
    const layoutA = resolveLayout()
    const { zip } = await exportBackup(layoutA, ALL)

    process.env.DSH_HOME = path.join(root, 'home-b')
    process.env.MNEMON_DATA_DIR = path.join(root, 'home-b-mnemon')
    const b = makeFakeHome(root, 'home-b')
    const layoutB = resolveLayout()
    // B 本机已有脏 WAL/SHM + 不同的 s1 + 不同的 settings
    fs.writeFileSync(path.join(layoutB.mnemonRoot, 'data', 'default', 'mnemon.db-wal'), 'STALE-WAL')
    fs.writeFileSync(path.join(layoutB.mnemonRoot, 'data', 'default', 'mnemon.db-shm'), 'STALE-SHM')
    fs.writeFileSync(b.p.s1, Buffer.from('B-LOCAL-S1'))
    fs.writeFileSync(b.p.settingsYaml, 'pet:\n  name: local\n')

    const { report } = await importBackup(zip, layoutB, 'replace', ALL)
    assert.ok(report.ok, '导入应无错误：' + JSON.stringify(report.errors))

    assert.ok(fs.readFileSync(b.p.s1).equals(fs.readFileSync(a.p.s1)), 's1 应被备份内容覆盖')
    assert.equal(fs.readFileSync(layoutB.p.settingsYaml, 'utf8'), 'ui-onboarding:\n  done: true\n')
    const baks = fs.readdirSync(path.join(root, 'home-b')).filter((n) => n.includes('.bak-dshbackup-'))
    assert.equal(baks.length, 1, 'settings.yaml 应留 .bak')
    assert.ok(!fs.existsSync(path.join(layoutB.mnemonRoot, 'data', 'default', 'mnemon.db-wal')), '旧 WAL 应被清掉')
    assert.ok(!fs.existsSync(path.join(layoutB.mnemonRoot, 'data', 'default', 'mnemon.db-shm')), '旧 SHM 应被清掉')
  } finally {
    process.env.DSH_HOME = prevHome
    process.env.MNEMON_DATA_DIR = prevMnemon
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('端到端：校验和不符的备份在抽取阶段被拒绝', async () => {
  const root = tmpRoot()
  const prevHome = process.env.DSH_HOME
  const prevMnemon = process.env.MNEMON_DATA_DIR
  try {
    makeFakeHome(root, 'home-a')
    const layoutA = resolveLayout()
    const { zip } = await exportBackup(layoutA, ALL)

    process.env.DSH_HOME = path.join(root, 'home-b')
    process.env.MNEMON_DATA_DIR = path.join(root, 'home-b-mnemon')
    fs.mkdirSync(path.join(root, 'home-b'), { recursive: true })
    const layoutB = resolveLayout()
    const { plan } = await importBackup(zip, layoutB, 'merge', ALL, { corruptSize: true })
    assert.ok(plan, '计划仍应生成')
  } finally {
    process.env.DSH_HOME = prevHome
    process.env.MNEMON_DATA_DIR = prevMnemon
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('端到端：不含 mnemon 的导入不创建 mnemon 目录骨架', async () => {
  const root = tmpRoot()
  const prevHome = process.env.DSH_HOME
  const prevMnemon = process.env.MNEMON_DATA_DIR
  try {
    makeFakeHome(root, 'home-a')
    const layoutA = resolveLayout()
    const { zip } = await exportBackup(layoutA, ['sessions'])

    process.env.DSH_HOME = path.join(root, 'home-fresh2')
    process.env.MNEMON_DATA_DIR = path.join(root, 'no-mnemon')
    fs.mkdirSync(path.join(root, 'home-fresh2'), { recursive: true })
    const layoutF = resolveLayout()
    const { report } = await importBackup(zip, layoutF, 'merge', ['sessions'])
    assert.ok(report.ok)
    assert.ok(!fs.existsSync(path.join(root, 'no-mnemon')), '不应凭空创建 mnemon 目录')
  } finally {
    process.env.DSH_HOME = prevHome
    process.env.MNEMON_DATA_DIR = prevMnemon
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('暂存区过期清理', async () => {
  const root = tmpRoot()
  const prevHome = process.env.DSH_HOME
  const prevMnemon = process.env.MNEMON_DATA_DIR
  try {
    process.env.DSH_HOME = path.join(root, 'h')
    process.env.MNEMON_DATA_DIR = path.join(root, 'h-mnemon')
    const layout = resolveLayout()
    const oldDir = path.join(layout.dshHome, '.dsh-backup-staging', 'dsh-backup-staging-1-abcdef')
    fs.mkdirSync(oldDir, { recursive: true })
    write(path.join(oldDir, 'x.txt'), 'x')
    await cleanupStale(layout, 0) // 全部视为过期
    assert.ok(!fs.existsSync(oldDir))
  } finally {
    process.env.DSH_HOME = prevHome
    process.env.MNEMON_DATA_DIR = prevMnemon
    fs.rmSync(root, { recursive: true, force: true })
  }
})
