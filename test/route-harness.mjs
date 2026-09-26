// ============================================================================
// HTTP 路由回归测试:用最小 mock ctx 复现 dsh-host-webserver 的调用方式,
// 真实起 HTTP 服务,逐端点断言(全部带超时,防 handler 挂死回归)。
// 回归背景:spoolRequest 曾因从不 end() 写流导致预检接口挂死
// (浏览器侧表现为 "Unexpected end of JSON input" 空响应);
// handleExport 曾在流式输出后 setHeader 导致连接被销毁。
// ============================================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { pathToFileURL } from 'node:url'

const TIMEOUT = 15000
const f = (p) => pathToFileURL(path.join(import.meta.dirname, '..', p)).href

test('HTTP 路由:全部端点正常响应,预检→执行全链路可用', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dshb-http-'))
  process.env.DSH_HOME = path.join(tmp, 'home-a')
  process.env.MNEMON_DATA_DIR = path.join(tmp, 'home-a-mnemon')
  fs.mkdirSync(path.join(tmp, 'home-a'), { recursive: true })

  // ---- 造假数据 ----
  const w = (abs, c) => { fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, c) }
  const sess = path.join(tmp, 'home-a', 'sessions', '--H-demo--')
  w(path.join(sess, '11111111-1111-4111-8111-111111111111', 'session.v3.jsonl.zstd'), Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 1, 2, 3, 4]))
  w(path.join(tmp, 'home-a', 'storages', 'workspace.json'), JSON.stringify({
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, workspaceIds: ['w1'], archivedSessionIds: [] },
    tables: { workspaces: { w1: { path: 'C:\\a', title: 'a', sessionIds: [], createdAt: 'T0', updatedAt: 'T0' } } },
  }))
  w(path.join(tmp, 'home-a', 'settings.yaml'), 'llm-deepseek:\n  apiKey: sk-test-123\n')
  w(path.join(tmp, 'home-a-mnemon', 'runtime', 'memories.json'), JSON.stringify({ version: 1, entries: [] }))
  w(path.join(tmp, 'home-a-mnemon', 'data', 'default', 'mnemon.db'), Buffer.concat([Buffer.from('SQLite format 3\0'), crypto.randomBytes(32)]))
  w(path.join(tmp, 'home-a', 'profiles', 'web', 'package.json'), JSON.stringify({ name: 'dsh-profile-web', dependencies: {}, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }))

  const { apply } = await import(f('lib/index.js'))
  const { assembleBackupZip, COMPONENTS } = await import(f('lib/store.js'))

  const routes = []
  const ctx = {
    settings: { register: () => ({ get: () => ({ defaultImportMode: 'merge', verifyChecksums: true, destination: path.join(tmp, 'bk'), keep: 7, redactSecrets: true }) }) },
    webServer: { register: (route) => { routes.push(route); return () => {} } },
    effect: (fn) => {},
    inject: (list, cb) => { /* commands 服务缺席 */ },
  }
  apply(ctx)
  const route = routes.find((r) => r.kind === 'prefix')
  assert.ok(route, 'prefix 路由应注册')

  const server = http.createServer(async (req, res) => {
    try {
      await route.handler(req, res)
    } catch (err) {
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' })
      try { res.end(JSON.stringify({ ok: false, error: String(err && err.message) })) } catch { /* ignore */ }
    }
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = 'http://127.0.0.1:' + server.address().port

  async function probeJson(name, p, init = {}) {
    const r = await fetch(base + p, { ...init, signal: AbortSignal.timeout(TIMEOUT) })
    const text = await r.text()
    let body = null
    try { body = JSON.parse(text) } catch {
      assert.fail(`${name}: 响应不是 JSON(status=${r.status}, len=${text.length}, head=${JSON.stringify(text.slice(0, 80))})`)
    }
    return { status: r.status, body }
  }

  try {
    // ---- JSON 端点全部可达且合法 ----
    for (const p of ['/dsh-backup/status', '/dsh-backup/estimate', '/dsh-backup/disk', '/dsh-backup/auto', '/dsh-backup/doctor']) {
      const { status, body } = await probeJson('GET ' + p, p)
      assert.equal(status, 200, p)
      assert.equal(body.ok, true, p)
    }

    // ---- 非法 verify 名 → 400 JSON ----
    const bad = await probeJson('GET /disk/verify?name=bad', '/dsh-backup/disk/verify?name=bad-name')
    assert.equal(bad.status, 400)
    assert.equal(bad.body.ok, false)

    // ---- 空 body 预检:必须快速返回 JSON 错误,不得挂死 ----
    const empty = await probeJson('POST /import?mode=preview (空body)', '/dsh-backup/import?mode=preview', { method: 'POST' })
    assert.equal(empty.status, 400)
    assert.equal(empty.body.ok, false)

    // ---- 构造真实备份 → 上传预检 → token 执行 → 数据落位 ----
    const layoutA = (await import(f('lib/store.js'))).resolveLayout()
    const chunks = []
    await assembleBackupZip(layoutA, new Set(COMPONENTS.map((c) => c.id)), { sink: { async write(c) { chunks.push(c) } }, redactSecrets: true })
    const zipBuf = Buffer.concat(chunks)

    const pv = await probeJson('POST /import?mode=preview (真包)', '/dsh-backup/import?mode=preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/zip' },
      body: zipBuf,
    })
    assert.equal(pv.status, 200)
    assert.equal(pv.body.ok, true)
    assert.ok(pv.body.token, '应有预检 token')
    assert.ok(pv.body.plan.components.sessions.files > 0)

    // 切换到目标 home(模拟换机恢复)
    process.env.DSH_HOME = path.join(tmp, 'home-b')
    process.env.MNEMON_DATA_DIR = path.join(tmp, 'home-b-mnemon')
    fs.mkdirSync(path.join(tmp, 'home-b'), { recursive: true })

    const ex = await probeJson('POST /import/execute', '/dsh-backup/import/execute?token=' + pv.body.token + '&mode=replace', { method: 'POST' })
    assert.equal(ex.status, 200)
    assert.equal(ex.body.ok, true)
    assert.equal(ex.body.report.components.workspaces.action, 'replaced')

    const sessB = path.join(tmp, 'home-b', 'sessions', '--H-demo--', '11111111-1111-4111-8111-111111111111', 'session.v3.jsonl.zstd')
    assert.ok(fs.existsSync(sessB), '会话应还原')
    assert.ok(fs.readFileSync(sessB).subarray(0, 4).equals(Buffer.from([0x28, 0xb5, 0x2f, 0xfd])))
    // 脱敏 settings:replace 导入时本机无现值 → 保留占位符
    const settingsB = fs.readFileSync(path.join(tmp, 'home-b', 'settings.yaml'), 'utf8')
    assert.ok(settingsB.includes('__DSHBACKUP_REDACTED__'), '未回填的密钥应保留占位符')

    // ---- 导出:流式 zip 完整(不被 headers-sent 破坏) ----
    process.env.DSH_HOME = path.join(tmp, 'home-b')
    const er = await fetch(base + '/dsh-backup/export?components=sessions,workspaces', { signal: AbortSignal.timeout(TIMEOUT) })
    const ebuf = Buffer.from(await er.arrayBuffer())
    assert.equal(er.status, 200)
    assert.ok(ebuf.length > 100, '导出应有内容,实际 ' + ebuf.length)
    assert.ok(ebuf[0] === 0x50 && ebuf[1] === 0x4b, '应为 ZIP(PK)魔数')
    // 能被 ZipReader 打开且条目完整(等价于 CRC 全过)
    const { ZipReader } = await import(f('lib/zip.js'))
    const exportPath = path.join(tmp, 'exported.zip')
    fs.writeFileSync(exportPath, ebuf)
    const reader = new ZipReader(exportPath)
    const entries = await reader.open()
    assert.ok(entries.length >= 3, '导出条目应完整: ' + entries.length)
    for (const e of entries) await reader.readEntry(e)
    await reader.close()

    // ---- rescue 工具包:zip 可下载 ----
    const rr = await fetch(base + '/dsh-backup/rescue', { signal: AbortSignal.timeout(TIMEOUT) })
    const rbuf = Buffer.from(await rr.arrayBuffer())
    assert.equal(rr.status, 200)
    assert.ok(rbuf.length > 1000 && rbuf[0] === 0x50)
  } finally {
    server.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})
