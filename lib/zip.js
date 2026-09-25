// ============================================================================
// dsh-backup —— 纯 JS 的 ZIP 流式读写（零第三方依赖）
//
// 为什么不用现成 zip 库：dsh 插件随 pnpm 装进 profile，依赖越少越不容易在
// harness 升级后坏掉。这里只依赖 node:fs / node:zlib / node:crypto。
//
// 写入：逐条目流式写本地文件头 + 数据 + 数据描述符（bit3），大文件不进内存；
//       大小/偏移 ≥ 4GiB 或条目数 ≥ 65535 时自动启用 zip64。
// 读取：先落盘 spool 文件，再解析 EOCD / zip64 EOCD + 中央目录，逐条目
//       seek 抽取（store / deflateRaw），逐条目校验 CRC32。
// ============================================================================

import fs from 'node:fs'
import path from 'node:path'
import { deflateRawSync, createDeflateRaw, inflateRaw } from 'node:zlib'
import { promisify } from 'node:util'

const inflateRawAsync = promisify(inflateRaw)

// ---------------------------------------------------------------------------
// CRC32（查表实现）
// ---------------------------------------------------------------------------
const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1)
    }
    table[n] = c
  }
  return table
})()

export function crc32() {
  let crc = -1
  return {
    update(chunk) {
      const table = CRC_TABLE
      let c = crc
      for (let i = 0; i < chunk.length; i++) {
        c = table[(c ^ chunk[i]) & 0xFF] ^ (c >>> 8)
      }
      crc = c
    },
    digest() {
      return (crc ^ -1) >>> 0
    },
  }
}

// ---------------------------------------------------------------------------
// DOS 时间（ZIP 只存本地时间，2 秒精度）
// ---------------------------------------------------------------------------
export function dosDateTime(date) {
  const d = date instanceof Date ? date : new Date()
  const time = ((d.getHours() & 0x1F) << 11) | ((d.getMinutes() & 0x3F) << 5) | ((d.getSeconds() / 2) & 0x1F)
  const day = (((d.getFullYear() - 1980) & 0x7F) << 9) | (((d.getMonth() + 1) & 0x0F) << 5) | (d.getDate() & 0x1F)
  return { time, date: day }
}

const U16_MAX = 0xFFFF
const U32_MAX = 0xFFFFFFFF

function u16(v) { const b = Buffer.alloc(2); b.writeUInt16LE(v & 0xFFFF, 0); return b }
function u32(v) { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0, 0); return b }
function u64(v) {
  const b = Buffer.alloc(8)
  b.writeBigUInt64LE(BigInt(v), 0)
  return b
}

// ---------------------------------------------------------------------------
// ZipWriter：向异步 sink（如 HTTP res）写一个 zip
//   sink 必须提供 write(chunk): Promise/boolean（false = 背压，需等 drain）
// ---------------------------------------------------------------------------
export class ZipWriter {
  constructor(sink) {
    this.sink = sink
    this.entries = []
    this.offset = 0
    this.closed = false
  }

  async _write(chunk) {
    if (!chunk || chunk.length === 0) return
    await this.sink.write(chunk)
    this.offset += chunk.length
  }

  /**
   * 添加一个文件条目。
   * @param {string} name    zip 内路径，一律使用正斜杠
   * @param {object} source  { buffer } 或 { stream: ReadStream, size, mtime }
   * @param {object} [opts]  { store: boolean, mtime: Date }
   */
  async addFile(name, source, opts = {}) {
    if (this.closed) throw new Error('ZipWriter already closed')
    const zipName = String(name).split(path.sep).join('/')
    const { time, date } = dosDateTime(opts.mtime)
    const entryOffset = this.offset
    let store = opts.store === true
    const crc = crc32()
    let uncompressed = 0
    let compressed = 0

    // zip64 判定需要先知道大小；流式时大小未知则按"可能超"处理：
    // 本地头启用 bit3 + zip64 extra（uncomp/comp 双 8 字节），大小落数据描述符。
    const sizeKnown = source.buffer ? true : Number.isFinite(source.size)
    const bigUnknown = !sizeKnown
    const needZip64LFH = bigUnknown
    const flags = 0x08 | 0x0800 // bit3 数据描述符 + UTF-8 名字
    const versionNeeded = needZip64LFH ? 45 : 20

    let header = Buffer.concat([
      u32(0x04034b50),
      u16(versionNeeded),
      u16(flags),
      u16(store ? 0 : 8),
      u16(time),
      u16(date),
      u32(0), // crc 占位（bit3）
      u32(0), // comp size 占位
      u32(0), // uncomp size 占位
      u16(Buffer.byteLength(zipName, 'utf8')),
      u16(needZip64LFH ? 20 : 0),
    ])
    if (needZip64LFH) {
      // zip64 extended information extra field（0x0001）：uncomp + comp 各 8 字节
      header = Buffer.concat([header, u16(0x0001), u16(16), u64(0), u64(0)])
    }
    header = Buffer.concat([header, Buffer.from(zipName, 'utf8')])
    await this._write(header)

    // ---- 数据 ----
    // addFile 只负责两类来源：内存 buffer，以及 store 模式的磁盘流。
    // 流式 deflate 需要一次读盘同时统计 CRC + 原始大小，统一走 addFromFile。
    if (source.buffer) {
      const raw = source.buffer
      uncompressed = raw.length
      crc.update(raw)
      let data
      if (store) {
        data = raw
      } else {
        data = deflateRawSync(raw, { level: 6 })
        // 极小段文本 deflate 后可能反而变大：ZIP 允许但没意义，回退 store
        if (data.length >= raw.length) {
          store = true
          data = raw
        }
      }
      compressed = data.length
      await this._write(data)
    } else if (store) {
      for await (const chunk of source.stream) {
        crc.update(chunk)
        uncompressed += chunk.length
        compressed += chunk.length
        await this._write(chunk)
      }
    } else {
      throw new Error('ZipWriter.addFile 不支持流式 deflate（请用 addFromFile）')
    }

    await this._write(Buffer.concat([u32(0x08074b50), u32(crc.digest()), u32(compressed), u32(uncompressed)]))

    this.entries.push({
      name: zipName,
      flags,
      method: store ? 0 : 8,
      time,
      date,
      crc: crc.digest(),
      compressed,
      uncompressed,
      entryOffset,
      needZip64: bigUnknown || compressed >= U32_MAX || uncompressed >= U32_MAX || entryOffset >= U32_MAX,
    })
    return this.entries[this.entries.length - 1]
  }

  /**
   * 从磁盘文件添加条目（自动选择 store / deflate；deflate 时用统计 Tap
   * 一次读盘同时得到 CRC 与原始大小）。
   */
  async addFromFile(absPath, zipName, opts = {}) {
    const stat = await fs.promises.stat(absPath)
    const store = opts.store === true || shouldStore(zipName)
    if (store) {
      const stream = fs.createReadStream(absPath)
      try {
        return await this.addFile(zipName, { stream, size: stat.size, mtime: stat.mtime }, { store: true, mtime: stat.mtime })
      } finally {
        stream.destroy()
      }
    }
    // deflate：用 Tap 流一次读盘同时统计
    const src = fs.createReadStream(absPath)
    const crc = crc32()
    let uncompressed = 0
    const { Transform } = await import('node:stream')
    const tap = new Transform({
      transform(chunk, _enc, cb) {
        crc.update(chunk)
        uncompressed += chunk.length
        cb(null, chunk)
      },
    })
    const deflater = createDeflateRaw({ level: 6 })
    const zipNameNorm = String(zipName).split(path.sep).join('/')
    const { time, date } = dosDateTime(stat.mtime)
    const entryOffset = this.offset
    const flags = 0x08 | 0x0800
    const header = Buffer.concat([
      u32(0x04034b50), u16(20), u16(flags), u16(8), u16(time), u16(date),
      u32(0), u32(0), u32(0),
      u16(Buffer.byteLength(zipNameNorm, 'utf8')), u16(0),
      Buffer.from(zipNameNorm, 'utf8'),
    ])
    await this._write(header)
    let compressed = 0
    try {
      const reader = src.pipe(tap).pipe(deflater)
      for await (const chunk of reader) {
        compressed += chunk.length
        await this._write(chunk)
      }
    } finally {
      src.destroy()
      tap.destroy()
      deflater.destroy()
    }
    const digest = crc.digest()
    await this._write(Buffer.concat([u32(0x08074b50), u32(digest), u32(compressed), u32(uncompressed)]))
    const entry = {
      name: zipNameNorm,
      flags,
      method: 8,
      time,
      date,
      crc: digest,
      compressed,
      uncompressed,
      entryOffset,
      needZip64: compressed >= U32_MAX || uncompressed >= U32_MAX || entryOffset >= U32_MAX,
    }
    this.entries.push(entry)
    return entry
  }

  addBuffer(name, buffer, opts = {}) {
    return this.addFile(name, { buffer }, opts)
  }

  /** 收尾：写中央目录 + EOCD（必要时 zip64）。 */
  async close() {
    if (this.closed) throw new Error('ZipWriter already closed')
    this.closed = true
    const cdStart = this.offset
    let needZip64Eocd = this.entries.length >= U16_MAX || cdStart >= U32_MAX

    for (const e of this.entries) {
      const zip64 = e.needZip64
      if (zip64) needZip64Eocd = true
      let extra = Buffer.alloc(0)
      if (zip64) {
        const fields = []
        if (e.uncompressed >= U32_MAX || e.compressed >= U32_MAX || true) {
          // 中央目录的 zip64 extra 字段顺序固定：uncomp, comp, disk#, offset
          fields.push(u64(e.uncompressed), u64(e.compressed))
          if (e.entryOffset >= U32_MAX) fields.push(u64(e.entryOffset))
        }
        extra = Buffer.concat([u16(0x0001), u16(fields.reduce((n, b) => n + b.length, 0)), ...fields])
      }
      const record = Buffer.concat([
        u32(0x02014b50),
        u16(0x031E), // version made by: UNIX
        u16(e.needZip64 ? 45 : 20),
        u16(e.flags),
        u16(e.method),
        u16(e.time),
        u16(e.date),
        u32(e.crc),
        u32(e.compressed >= U32_MAX ? U32_MAX : e.compressed),
        u32(e.uncompressed >= U32_MAX ? U32_MAX : e.uncompressed),
        u16(Buffer.byteLength(e.name, 'utf8')),
        u16(extra.length),
        u16(0), // comment len
        u16(0), // disk start
        u16(0), // internal attrs
        u32(0o100644 << 16), // external attrs: 常规文件 0644
        u32(e.entryOffset >= U32_MAX ? U32_MAX : e.entryOffset),
        Buffer.from(e.name, 'utf8'),
        extra,
      ])
      await this._write(record)
    }

    const cdSize = this.offset - cdStart
    const cdOffset = cdStart
    const entries = this.entries.length

    if (needZip64Eocd) {
      const zip64EocdOffset = this.offset
      await this._write(Buffer.concat([
        u32(0x06064b50),
        u64(44), // size of record
        u16(0x031E), u16(45),
        u32(0), u32(0), // disk numbers
        u64(entries), u64(entries),
        u64(cdSize), u64(cdOffset),
      ]))
      await this._write(Buffer.concat([
        u32(0x07064b50),
        u32(0), // disk number
        u64(zip64EocdOffset),
        u32(1), // total disks
      ]))
    }

    const eocd = Buffer.concat([
      u32(0x06054b50),
      u16(0), u16(0),
      u16(entries >= U16_MAX ? U16_MAX : entries),
      u16(entries >= U16_MAX ? U16_MAX : entries),
      u32(cdSize >= U32_MAX ? U32_MAX : cdSize),
      u32(cdOffset >= U32_MAX ? U32_MAX : cdOffset),
      u16(0),
    ])
    await this._write(eocd)
    return { entries, cdSize, cdOffset }
  }
}

// 已压缩/数据库类内容不再二次 deflate（收益趋零、纯耗 CPU）
const STORE_EXT = new Set([
  '.zstd', '.zst', '.gz', '.zip', '.xz', '.7z', '.rar', '.bz2', '.br',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.mp3', '.mp4', '.wav',
  '.ogg', '.webm', '.mov', '.avi', '.pdf', '.db', '.sqlite', '.sqlite3',
])

export function shouldStore(zipName) {
  const ext = path.posix.extname(String(zipName).toLowerCase())
  return STORE_EXT.has(ext)
}

// ---------------------------------------------------------------------------
// ZipReader：从 spool 文件解析并抽取
// ---------------------------------------------------------------------------
export class ZipReader {
  constructor(absPath) {
    this.absPath = absPath
    this.fd = null
    this.entries = []
  }

  async open() {
    this.fd = await fs.promises.open(this.absPath, 'r')
    // autoClose:false 的读取流会在同一 fd 上累积 close 监听器，放宽上限
    if (typeof this.fd.setMaxListeners === 'function') this.fd.setMaxListeners(0)
    const size = (await this.fd.stat()).size
    const eocd = await this._findEocd(size)
    let cdOffset = eocd.cdOffset
    let cdSize = eocd.cdSize
    let entryCount = eocd.entryCount
    if (eocd.zip64) {
      const rec = eocd.zip64
      cdOffset = Number(rec.cdOffset)
      cdSize = Number(rec.cdSize)
      entryCount = Number(rec.entryCount)
    }
    const cdBuf = Buffer.alloc(Math.min(cdSize, 64 * 1024 * 1024))
    await this.fd.read(cdBuf, 0, cdBuf.length, cdOffset)
    // 中央目录通常远小于 64MB；超出时分块读
    let entriesRaw = cdBuf
    if (cdSize > cdBuf.length) {
      entriesRaw = Buffer.alloc(cdSize)
      await this.fd.read(entriesRaw, 0, cdSize, cdOffset)
    }
    this.entries = this._parseCentralDirectory(entriesRaw, entryCount)
    return this.entries
  }

  async _findEocd(size) {
    const scanWindow = Math.min(size, 22 + 0xFFFF + 64)
    const tail = Buffer.alloc(scanWindow)
    await this.fd.read(tail, 0, scanWindow, size - scanWindow)
    // 从尾部向前找 EOCD 签名
    let eocdIdx = -1
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) { eocdIdx = i; break }
    }
    if (eocdIdx < 0) throw new Error('不是有效的 ZIP 文件（找不到 EOCD）')
    const absEocd = size - scanWindow + eocdIdx
    const entryCount = tail.readUInt16LE(eocdIdx + 10)
    const cdSize = tail.readUInt32LE(eocdIdx + 12)
    const cdOffset = tail.readUInt32LE(eocdIdx + 16)

    // zip64：EOCD 前紧邻 20 字节 locator（0x07064b50）
    if (absEocd >= 20) {
      const loc = Buffer.alloc(20)
      await this.fd.read(loc, 0, 20, absEocd - 20)
      if (loc.readUInt32LE(0) === 0x07064b50) {
        const z64Offset = Number(loc.readBigUInt64LE(8))
        const rec = Buffer.alloc(56)
        await this.fd.read(rec, 0, 56, z64Offset)
        if (rec.readUInt32LE(0) !== 0x06064b50) throw new Error('ZIP64 EOCD 损坏')
        return {
          zip64: {
            entryCount: rec.readBigUInt64LE(32),
            cdSize: rec.readBigUInt64LE(40),
            cdOffset: rec.readBigUInt64LE(48),
          },
          entryCount,
          cdSize,
          cdOffset,
        }
      }
    }
    return { zip64: null, entryCount, cdSize, cdOffset }
  }

  _parseCentralDirectory(buf, expectedCount) {
    const entries = []
    let p = 0
    while (p + 4 <= buf.length && buf.readUInt32LE(p) === 0x02014b50) {
      const flags = buf.readUInt16LE(p + 8)
      const method = buf.readUInt16LE(p + 10)
      const crc = buf.readUInt32LE(p + 16)
      let compressed = buf.readUInt32LE(p + 20)
      let uncompressed = buf.readUInt32LE(p + 24)
      const nameLen = buf.readUInt16LE(p + 28)
      const extraLen = buf.readUInt16LE(p + 30)
      const commentLen = buf.readUInt16LE(p + 32)
      let lfhOffset = buf.readUInt32LE(p + 42)
      const name = buf.toString('utf8', p + 46, p + 46 + nameLen)
      let extra = p + 46 + nameLen
      const extraEnd = extra + extraLen
      // zip64 extra（0x0001）：uncomp, comp, disk#, offset 依次排列
      while (extra + 4 <= extraEnd) {
        const headerId = buf.readUInt16LE(extra)
        const fieldSize = buf.readUInt16LE(extra + 2)
        if (headerId === 0x0001) {
          let q = extra + 4
          const qEnd = q + fieldSize
          if (uncompressed === U32_MAX && q + 8 <= qEnd) { uncompressed = Number(buf.readBigUInt64LE(q)); q += 8 }
          if (compressed === U32_MAX && q + 8 <= qEnd) { compressed = Number(buf.readBigUInt64LE(q)); q += 8 }
          if (lfhOffset === U32_MAX && q + 8 <= qEnd) { lfhOffset = Number(buf.readBigUInt64LE(q)); q += 8 }
        }
        extra += 4 + fieldSize
      }
      entries.push({ name, flags, method, crc, compressed, uncompressed, lfhOffset })
      p = extraEnd + commentLen
    }
    if (expectedCount > 0 && entries.length === 0) throw new Error('ZIP 中央目录损坏')
    return entries
  }

  /**
   * 读取一个条目的完整内容（小文件用；manifest / checksums）。
   */
  async readEntry(entry) {
    const { start } = await this._locateData(entry)
    const buf = Buffer.alloc(entry.compressed)
    await this.fd.read(buf, 0, entry.compressed, start)
    return this._decode(entry, buf)
  }

  /**
   * 把一个条目解压写入目标文件流（大文件用），返回 { crc, size }。
   */
  async extractEntryTo(entry, writeChunk) {
    const { start } = await this._locateData(entry)
    const crc = crc32()
    let size = 0
    if (entry.compressed === 0) {
      // 空条目：createReadStream 的 end 是闭区间，0 字节条目直接跳过流式读取
      if (crc.digest() !== entry.crc) throw new Error(`CRC 校验失败：${entry.name}`)
      return { crc: crc.digest(), size }
    }
    // 注意：FileHandle.createReadStream 只接受 options 对象；end 为闭区间；
    // autoClose 必须关掉 —— fd 是 ZipReader 持有的，不能被单条目流顺手关闭
    const stream = this.fd.createReadStream({ start, end: start + entry.compressed - 1, autoClose: false })
    if (entry.method === 0) {
      for await (const chunk of stream) {
        crc.update(chunk)
        size += chunk.length
        await writeChunk(chunk)
      }
    } else if (entry.method === 8) {
      // 大文件流式解压
      const { createInflateRaw } = await import('node:zlib')
      const inflator = createInflateRaw()
      const reader = stream.pipe(inflator)
      for await (const chunk of reader) {
        crc.update(chunk)
        size += chunk.length
        await writeChunk(chunk)
      }
      inflator.close()
    } else {
      throw new Error(`不支持的 ZIP 压缩方法 ${entry.method}（条目 ${entry.name}）`)
    }
    if (crc.digest() !== entry.crc) {
      throw new Error(`CRC 校验失败：${entry.name}`)
    }
    if (size !== entry.uncompressed) {
      throw new Error(`解压后大小不符（期望 ${entry.uncompressed}，实际 ${size}）：${entry.name}`)
    }
    return { crc: crc.digest(), size }
  }

  async _decode(entry, buf) {
    let data = buf
    if (entry.method === 8) {
      data = await inflateRawAsync(buf)
    } else if (entry.method !== 0) {
      throw new Error(`不支持的 ZIP 压缩方法 ${entry.method}（条目 ${entry.name}）`)
    }
    const crc = crc32()
    crc.update(data)
    if (crc.digest() !== entry.crc) throw new Error(`CRC 校验失败：${entry.name}`)
    if (data.length !== entry.uncompressed) throw new Error(`条目大小不符：${entry.name}`)
    return data
  }

  /** 定位条目数据区起点（本地头的名字/extra 长度可能与中央目录不同）。 */
  async _locateData(entry) {
    const lfh = Buffer.alloc(30)
    await this.fd.read(lfh, 0, 30, entry.lfhOffset)
    if (lfh.readUInt32LE(0) !== 0x04034b50) throw new Error(`ZIP 本地文件头损坏：${entry.name}`)
    const nameLen = lfh.readUInt16LE(26)
    const extraLen = lfh.readUInt16LE(28)
    return { start: entry.lfhOffset + 30 + nameLen + extraLen }
  }

  async close() {
    if (this.fd) {
      await this.fd.close()
      this.fd = null
    }
  }
}

/**
 * zip 内路径安全化：只接受 payload/ 与根下的常规文件路径。
 * 返回正斜杠规范路径；非法（穿越 / 绝对路径 / 驱动器号）时抛错。
 */
export function sanitizeZipName(name) {
  let p = String(name).replace(/\\/g, '/')
  p = p.replace(/^\.\/+/, '')
  if (/^[a-zA-Z]:/.test(p) || p.startsWith('/')) throw new Error(`非法 zip 路径：${name}`)
  const parts = p.split('/')
  for (const seg of parts) {
    if (seg === '..') throw new Error(`zip 路径穿越：${name}`)
    if (seg.includes('\0')) throw new Error(`zip 路径含空字节：${name}`)
  }
  const clean = parts.filter((s) => s.length > 0).join('/')
  if (!clean) throw new Error(`空 zip 路径：${name}`)
  return clean
}
