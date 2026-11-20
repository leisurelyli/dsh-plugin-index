/**
 * Safe, zero-dependency in-memory `.tgz` (gzip + USTAR / PAX / GNU tar) reader.
 * Never executes package code or writes unpacked files to disk; enforces compressed
 * and unpacked size limits, checks SRI integrity, skips `node_modules`, and rejects
 * path traversal outside the package root.
 */
import { createHash, getHashes } from 'node:crypto'
import { posix } from 'node:path'
import { gunzipSync } from 'node:zlib'

export const MAX_TEXT_FILE_BYTES = 1024 * 1024

/** Read-only file tree backed by in-memory buffers or lazy blob readers. */
export class PackageFiles {
  #files
  #children = new Map()

  constructor(files) {
    this.#files = files
    for (const filePath of files.keys()) {
      const segments = filePath.split('/')
      segments.forEach((name, depth) => {
        const dir = segments.slice(0, depth).join('/')
        let children = this.#children.get(dir)
        if (!children) {
          children = { directories: new Set(), files: [] }
          this.#children.set(dir, children)
        }
        if (depth === segments.length - 1) children.files.push(name)
        else children.directories.add(name)
      })
    }
  }

  static resolve(base, reference) {
    if (typeof reference !== 'string' || posix.isAbsolute(reference)) return undefined
    const normalized = posix.normalize(posix.join(base, reference)).replace(/\/$/u, '')
    if (normalized === '..' || normalized.startsWith('../')) return undefined
    return normalized === '.' ? '' : normalized
  }

  file(filePath) {
    return this.#files.get(filePath)
  }

  async read(filePath) {
    const entry = this.#files.get(filePath)
    if (!entry) return undefined
    if (entry.size > MAX_TEXT_FILE_BYTES) {
      throw new Error(`${filePath} exceeds ${MAX_TEXT_FILE_BYTES} bytes`)
    }
    return await entry.read()
  }

  directories(dir) {
    return [...(this.#children.get(dir)?.directories ?? [])].sort()
  }

  fileNames(dir) {
    return [...(this.#children.get(dir)?.files ?? [])].sort()
  }

  within(dir) {
    if (dir === '') return this
    const prefix = `${dir}/`
    const inside = new Map()
    for (const [filePath, entry] of this.#files) {
      if (filePath.startsWith(prefix)) inside.set(filePath.slice(prefix.length), entry)
    }
    return new PackageFiles(inside)
  }
}

/** Verify bytes against a Subresource Integrity string (e.g. `sha512-...`). */
export function matchesIntegrity(bytes, integrity) {
  if (typeof integrity !== 'string') return false
  const supported = new Set(getHashes())
  const tokens = integrity.trim().split(/\s+/u)
  const usable = []
  for (const token of tokens) {
    const m = /^(sha\d+)-([A-Za-z0-9+/=]+)$/u.exec(token)
    if (m && supported.has(m[1])) usable.push([m[1], m[2]])
  }
  if (usable.length === 0) return false
  return usable.some(([alg, digest]) => createHash(alg).update(bytes).digest('base64') === digest)
}

function parseOctalOrBase256(buf) {
  // GNU base-256 numeric encoding when high bit is set
  if ((buf[0] & 0x80) !== 0) {
    let value = 0
    for (let i = 1; i < buf.length; i++) value = value * 256 + buf[i]
    return value
  }
  const str = buf.toString('ascii').replace(/\0.*$/u, '').trim()
  if (str === '') return 0
  return parseInt(str, 8)
}

function parsePaxHeaders(buf) {
  const headers = {}
  let offset = 0
  while (offset < buf.length) {
    const space = buf.indexOf(0x20, offset)
    if (space === -1) break
    const len = parseInt(buf.subarray(offset, space).toString('ascii'), 10)
    if (!Number.isInteger(len) || len <= 0 || offset + len > buf.length) break
    const record = buf.subarray(space + 1, offset + len - 1).toString('utf8')
    const eq = record.indexOf('=')
    if (eq !== -1) headers[record.slice(0, eq)] = record.slice(eq + 1)
    offset += len
  }
  return headers
}

/**
 * Unpack a `.tgz` buffer into an in-memory {@link PackageFiles}, stripping the
 * leading directory segment (npm's `package/`), excluding `node_modules`, and
 * enforcing `maxUnpackedBytes`.
 */
export function unpackTgz(gzBytes, label, maxUnpackedBytes = 256 * 1024 * 1024) {
  let tar
  try {
    tar = gunzipSync(gzBytes, { maxOutputLength: maxUnpackedBytes + 1024 * 1024 })
  } catch (err) {
    throw new Error(`${label}: failed to gunzip tarball (${err.message})`)
  }

  const files = new Map()
  let offset = 0
  let totalFileBytes = 0
  let nextPax = null
  let globalPax = {}
  let gnuLongName = null

  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512)
    let allZero = true
    for (let i = 0; i < 512; i++) {
      if (header[i] !== 0) {
        allZero = false
        break
      }
    }
    if (allZero) break

    const rawName = header.subarray(0, 100).toString('utf8').replace(/\0.*$/u, '')
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/u, '')
    const typeFlag = String.fromCharCode(header[156])
    let size = parseOctalOrBase256(header.subarray(124, 136))

    offset += 512
    const effectivePax = nextPax ? { ...globalPax, ...nextPax } : globalPax
    if (effectivePax.size !== undefined) {
      const paxSize = Number(effectivePax.size)
      if (Number.isSafeInteger(paxSize) && paxSize >= 0) size = paxSize
    }

    if (offset + size > tar.length) {
      throw new Error(`${label}: truncated tar entry`)
    }
    const content = tar.subarray(offset, offset + size)
    offset += Math.ceil(size / 512) * 512

    if (typeFlag === 'x') {
      nextPax = parsePaxHeaders(content)
      continue
    }
    if (typeFlag === 'g') {
      globalPax = { ...globalPax, ...parsePaxHeaders(content) }
      continue
    }
    if (typeFlag === 'L') {
      gnuLongName = content.toString('utf8').replace(/\0.*$/u, '')
      continue
    }

    const rawFullPath = nextPax?.path ?? gnuLongName ?? (prefix ? `${prefix}/${rawName}` : rawName)
    nextPax = null
    gnuLongName = null

    // Only keep regular files (`'0'` or `'\0'`). Ignore directories, symlinks, hardlinks, etc.
    if (typeFlag !== '0' && typeFlag !== '\0') continue

    const stripped = rawFullPath.replace(/^\.\//u, '').split('/').slice(1).join('/')
    const relPath = PackageFiles.resolve('', stripped)
    if (!relPath || relPath.split('/').includes('node_modules')) continue

    totalFileBytes += content.length
    if (totalFileBytes > maxUnpackedBytes) {
      throw new Error(`${label}: unpacked tarball exceeds ${maxUnpackedBytes} bytes`)
    }

    // Keep metadata-sized files in memory and skip copying giant JS/WASM assets that cannot be read as text/icons
    const sizeBytes = content.length
    if (sizeBytes > MAX_TEXT_FILE_BYTES) {
      files.set(relPath, {
        size: sizeBytes,
        read: () => Promise.reject(new Error(`${relPath} exceeds ${MAX_TEXT_FILE_BYTES} bytes`)),
      })
      continue
    }
    const copied = Buffer.from(content)
    files.set(relPath, {
      size: copied.length,
      read: () => Promise.resolve(copied),
    })
  }

  return new PackageFiles(files)
}
