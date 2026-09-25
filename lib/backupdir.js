// ============================================================================
// dsh-backup —— 磁盘备份引擎（自动备份 / /backup 命令共用）
//
// 把 assembleBackupZip 的产物写到备份目录：
//   dsh-backup-<时间戳>.zip + <同名>.sha256 + rescue.mjs + 三平台双击启动器
// 备份后按 keep 轮换（新→旧保留 N 份，连同 sidecar 一起删）。
// sha256 在写 zip 时同步计算（tee），不二次读盘。
// ============================================================================

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

import {
  assembleBackupZip, rotateBackups, backupFileName,
  COMPONENTS,
} from './store.js'
import { ZipReader } from './zip.js'

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const RESCUE_SRC = path.join(PLUGIN_ROOT, 'rescue', 'rescue.mjs')

const LAUNCHERS = [
  {
    name: '点我恢复.bat',
    body: [
      '@echo off',
      'title dsh-backup 救援控制台',
      'chcp 65001 >nul',
      'where node >nul 2>nul',
      'if errorlevel 1 (',
      '  echo 未找到 node。请先安装 Node.js: https://nodejs.org/',
      '  pause',
      '  exit /b 1',
      ')',
      'node "%~dp0rescue.mjs"',
      'pause',
    ].join('\r\n') + '\r\n',
  },
  {
    name: '点我恢复.command',
    body: [
      '#!/bin/bash',
      'cd "$(dirname "$0")"',
      'if ! command -v node >/dev/null 2>&1; then',
      '  echo "未找到 node。请先安装 Node.js: https://nodejs.org/"',
      '  read -n 1 -s -r -p "按任意键关闭..."',
      '  exit 1',
      'fi',
      'node rescue.mjs',
      'read -p "按回车关闭..." _',
      '',
    ].join('\n'),
    exec: true,
  },
  {
    name: '点我恢复.sh',
    body: [
      '#!/bin/bash',
      'cd "$(dirname "$0")"',
      'if ! command -v node >/dev/null 2>&1; then',
      '  echo "未找到 node。请先安装 Node.js: https://nodejs.org/"',
      '  exit 1',
      'fi',
      'node rescue.mjs',
      '',
    ].join('\n'),
    exec: true,
  },
]

export function defaultBackupDir() {
  const desktop = path.join(os.homedir(), 'Desktop')
  if (fs.existsSync(desktop)) return path.join(desktop, 'dsh-backups')
  return path.join(os.homedir(), 'dsh-backups')
}

/** 把救援控制台 + 双击启动器写进备份目录（幂等，随每次备份刷新）。 */
export async function writeRescueTools(destination) {
  await fs.promises.mkdir(destination, { recursive: true })
  try {
    await fs.promises.copyFile(RESCUE_SRC, path.join(destination, 'rescue.mjs'))
  } catch { /* 插件目录被裁剪时跳过（files 字段未含 rescue/ 的旧包） */ }
  for (const l of LAUNCHERS) {
    const abs = path.join(destination, l.name)
    await fs.promises.writeFile(abs, l.body, 'utf8').catch(() => {})
    if (l.exec && process.platform !== 'win32') {
      await fs.promises.chmod(abs, 0o755).catch(() => {})
    }
  }
}

/** 校验一个备份文件：逐条目解压比对 CRC。返回 { ok, entries, bad } */
export async function verifyBackupFile(abs) {
  const reader = new ZipReader(abs)
  try {
    const entries = await reader.open()
    const bad = []
    for (const e of entries) {
      try { await reader.readEntry(e) } catch (err) {
        bad.push({ name: e.name, reason: String((err && err.message) || err) })
      }
    }
    return { ok: bad.length === 0, entries: entries.length, bad }
  } finally {
    await reader.close()
  }
}

/**
 * 执行一次磁盘备份。
 * @returns { name, path, sha256, bytes, fileCount, redacted, removed }
 */
export async function backupToFile({ layout, destination, keep = 7, redactSecrets = true, components, onLog } = {}) {
  const dest = path.resolve(destination || defaultBackupDir())
  await fs.promises.mkdir(dest, { recursive: true })
  const name = backupFileName()
  const final = path.join(dest, name)
  const tmp = final + '.part'

  const ws = fs.createWriteStream(tmp)
  const hash = crypto.createHash('sha256')
  let closed = false
  const finishStream = () => new Promise((resolve, reject) => {
    ws.end(() => resolve())
    ws.on('error', reject)
  })
  const sink = {
    async write(chunk) {
      if (!ws.write(chunk)) await new Promise((resolve) => ws.once('drain', resolve))
    },
  }

  try {
    const result = await assembleBackupZip(layout, components || new Set(COMPONENTS.filter((c) => c.id !== 'extensions').map((c) => c.id)), {
      sink,
      redactSecrets: redactSecrets !== false,
      onChunk: (chunk) => hash.update(chunk),
    })
    await finishStream()
    closed = true
    await fs.promises.rename(tmp, final)
    const digest = hash.digest('hex')
    await fs.promises.writeFile(final + '.sha256', digest + '  ' + name + '\n', 'utf8')
    await writeRescueTools(dest)
    const removed = await rotateBackups(dest, keep)
    if (onLog) onLog(`备份完成: ${name}（${(result.bytes / 1048576).toFixed(1)}MB，${result.fileCount} 文件）`)
    return {
      name,
      path: final,
      sha256: digest,
      bytes: result.bytes,
      fileCount: result.fileCount,
      redacted: result.redacted,
      removed,
      destination: dest,
    }
  } catch (err) {
    try { if (!closed) ws.destroy() } catch { /* ignore */ }
    await fs.promises.unlink(tmp).catch(() => {})
    await fs.promises.unlink(final).catch(() => {})
    throw err
  }
}
