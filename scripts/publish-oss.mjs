#!/usr/bin/env node
/**
 * Publish generated DSH Format-1 plugin market static artifacts (`site/`) to Aliyun OSS.
 * Zero external runtime dependencies — runs natively on Node.js 24+.
 *
 * Upload order guarantees readers never observe a dangling icon reference:
 *   1. Validate `site/index.json` and every local icon file against Format 1.
 *   2. Upload content-hashed `site/icons/*` FIRST (immutable cache; skips unchanged objects).
 *   3. Upload `site/index.html` (short cache).
 *   4. Upload `site/index.json` LAST (short cache, `application/json; charset=utf-8`).
 *   5. Verify anonymous public HTTPS GET on `index.json` (HTTP 200, zero redirects,
 *      SHA-256 match, valid Format 1) and HEAD on every external icon URL (HTTP 200, zero redirects).
 */

import { createHash, createHmac } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseMarketIndex } from './lib/format1.mjs'
import { validateIndexFile } from './validate-index.mjs'

export const DEFAULT_OSS_BUCKET = 'mindeck-desktop-releases'
export const DEFAULT_OSS_REGION = 'cn-hangzhou'
export const DEFAULT_OSS_PREFIX = 'plugin-market'
const DEFAULT_MAX_RETRIES = 3

const MIME_BY_EXT = new Map([
  ['.json', 'application/json; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
])

/**
 * Encode an OSS object key segment-by-segment preserving "/".
 * @param {string} key
 */
export function encodeOssKey(key) {
  return key.replace(/^\/+/u, '').split('/').map(encodeURIComponent).join('/')
}

/**
 * Compute Aliyun OSS V1 Authorization header (HMAC-SHA1).
 * @param {{
 *   method: string,
 *   bucket: string,
 *   objectKey: string,
 *   contentType?: string,
 *   date: string,
 *   headers?: Record<string, string>,
 *   accessKeyId: string,
 *   accessKeySecret: string,
 * }} params
 */
export function signOssRequest({
  method,
  bucket,
  objectKey,
  contentType = '',
  date,
  headers = {},
  accessKeyId,
  accessKeySecret,
}) {
  const ossHeaders = Object.entries(headers)
    .filter(([k]) => k.toLowerCase().startsWith('x-oss-'))
    .map(([k, v]) => `${k.toLowerCase()}:${String(v).trim()}`)
    .sort()
    .join('\n')
  const canonicalOss = ossHeaders ? `${ossHeaders}\n` : ''
  const normalizedKey = objectKey.replace(/^\/+/u, '')
  const canonicalResource = `/${bucket}/${normalizedKey}`
  const stringToSign = `${method}\n\n${contentType}\n${date}\n${canonicalOss}${canonicalResource}`
  const signature = createHmac('sha1', accessKeySecret).update(stringToSign).digest('base64')
  return `OSS ${accessKeyId}:${signature}`
}

function sha256Hex(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

async function withRetries(fn, maxRetries = DEFAULT_MAX_RETRIES) {
  let lastError
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn(attempt)
    } catch (error) {
      lastError = error
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, attempt * 1000))
      }
    }
  }
  throw lastError
}

function createOssClient({ bucket, region, accessKeyId, accessKeySecret, fetchImpl = fetch }) {
  const ossBaseUrl = `https://${bucket}.oss-${region}.aliyuncs.com`

  async function request({ method, objectKey, contentType = '', headers = {}, body = undefined }) {
    const date = new Date().toUTCString()
    const auth = signOssRequest({
      method,
      bucket,
      objectKey,
      contentType,
      date,
      headers,
      accessKeyId,
      accessKeySecret,
    })
    const reqHeaders = { Date: date, Authorization: auth, ...headers }
    if (contentType) reqHeaders['Content-Type'] = contentType
    const url = `${ossBaseUrl}/${encodeOssKey(objectKey)}`
    return withRetries(async () => {
      const response = await fetchImpl(url, { method, headers: reqHeaders, body })
      if (response.status >= 500) {
        const errText = await response.text().catch(() => '')
        throw new Error(`OSS ${method} /${objectKey} returned ${response.status}: ${errText.slice(0, 300)}`)
      }
      return response
    })
  }

  async function headObject(objectKey) {
    const response = await request({ method: 'HEAD', objectKey })
    if (response.status === 404) return null
    if (!response.ok) throw new Error(`OSS HEAD /${objectKey} failed with ${response.status}`)
    return {
      contentLength: Number(response.headers.get('content-length') ?? -1),
      sha256: response.headers.get('x-oss-meta-sha256') ?? undefined,
    }
  }

  async function putBuffer(objectKey, buffer, { contentType, cacheControl, metadata = {} }) {
    const headers = {}
    if (cacheControl) headers['Cache-Control'] = cacheControl
    for (const [k, v] of Object.entries(metadata)) {
      if (v !== undefined) headers[`x-oss-meta-${k}`] = String(v)
    }
    const response = await request({ method: 'PUT', objectKey, contentType, headers, body: buffer })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new Error(`OSS PUT /${objectKey} failed (${response.status}): ${text.slice(0, 400)}`)
    }
  }

  return { ossBaseUrl, headObject, putBuffer }
}

/**
 * Collect ordered upload plan from `site/` directory:
 *   1. `icons/*` (immutable)
 *   2. `index.html` (if present)
 *   3. `index.json` (ALWAYS LAST)
 * @param {string} siteDir
 * @param {string} cleanPrefix
 */
export function planSiteUploads(siteDir, cleanPrefix) {
  const absDir = resolve(siteDir)
  const indexPath = join(absDir, 'index.json')
  if (!existsSync(indexPath)) {
    throw new Error(`Missing built index file: ${indexPath} (run \`npm run build\` first)`)
  }
  const keyOf = (rel) => (cleanPrefix ? `${cleanPrefix}/${rel}` : rel)
  const items = []

  const iconsDir = join(absDir, 'icons')
  if (existsSync(iconsDir)) {
    const iconNames = readdirSync(iconsDir).sort((a, b) => a.localeCompare(b))
    for (const name of iconNames) {
      const ext = extname(name).toLowerCase()
      const contentType = MIME_BY_EXT.get(ext)
      if (!contentType) continue
      const filePath = join(iconsDir, name)
      const bytes = readFileSync(filePath)
      items.push({
        relPath: `icons/${name}`,
        objectKey: keyOf(`icons/${name}`),
        filePath,
        bytes,
        sha256: sha256Hex(bytes),
        contentType,
        cacheControl: 'public, max-age=31536000, immutable',
        immutable: true,
      })
    }
  }

  const htmlPath = join(absDir, 'index.html')
  if (existsSync(htmlPath)) {
    const bytes = readFileSync(htmlPath)
    items.push({
      relPath: 'index.html',
      objectKey: keyOf('index.html'),
      filePath: htmlPath,
      bytes,
      sha256: sha256Hex(bytes),
      contentType: 'text/html; charset=utf-8',
      cacheControl: 'public, max-age=300, must-revalidate',
      immutable: false,
    })
  }

  const indexBytes = readFileSync(indexPath)
  items.push({
    relPath: 'index.json',
    objectKey: keyOf('index.json'),
    filePath: indexPath,
    bytes: indexBytes,
    sha256: sha256Hex(indexBytes),
    contentType: 'application/json; charset=utf-8',
    cacheControl: 'public, max-age=300, must-revalidate',
    immutable: false,
  })

  return items
}

/**
 * Validate and publish the built `site/` directory to Aliyun OSS.
 */
export async function publishPluginIndexToOss({
  siteDir = 'site',
  bucket = DEFAULT_OSS_BUCKET,
  region = DEFAULT_OSS_REGION,
  prefix = DEFAULT_OSS_PREFIX,
  publicBaseUrl = '',
  accessKeyId = '',
  accessKeySecret = '',
  dryRun = false,
  skipVerify = false,
  fetchImpl = fetch,
  log = (msg) => process.stdout.write(`${msg}\n`),
} = {}) {
  const absSiteDir = resolve(siteDir)
  const cleanPrefix = prefix.replace(/^\/+|\/+$/gu, '')
  const resolvedPublicBase = (publicBaseUrl || `https://${bucket}.oss-${region}.aliyuncs.com`).replace(/\/+$/u, '')
  const indexKey = cleanPrefix ? `${cleanPrefix}/index.json` : 'index.json'
  const indexUrl = `${resolvedPublicBase}/${encodeOssKey(indexKey)}`
  const catalogUrl = `${resolvedPublicBase}/${encodeOssKey(cleanPrefix ? `${cleanPrefix}/index.html` : 'index.html')}`

  // 1. Validate local index & icons strictly before any upload.
  const { parsed } = validateIndexFile(join(absSiteDir, 'index.json'), indexUrl)
  const plan = planSiteUploads(absSiteDir, cleanPrefix)

  if (dryRun) {
    log(`[dry-run] Validated Format 1 index (${parsed.plugins.length} plugins) for ${indexUrl}`)
    for (const item of plan) {
      log(`[dry-run]   PUT /${item.objectKey} (${item.bytes.length} bytes, ${item.contentType}, ${item.cacheControl})`)
    }
    return {
      dryRun: true,
      indexUrl,
      catalogUrl,
      pluginCount: parsed.plugins.length,
      uploadedKeys: [],
      skippedKeys: [],
      plannedKeys: plan.map((item) => item.objectKey),
    }
  }

  if (!accessKeyId || !accessKeySecret) {
    throw new Error('Missing Aliyun OSS credentials (ALIYUN_OSS_ACCESS_KEY_ID / ALIYUN_OSS_ACCESS_KEY_SECRET)')
  }

  const client = createOssClient({ bucket, region, accessKeyId, accessKeySecret, fetchImpl })
  const uploadedKeys = []
  const skippedKeys = []

  // 2. Upload icons first, then index.html, then index.json LAST.
  for (const item of plan) {
    if (item.immutable) {
      const existing = await client.headObject(item.objectKey)
      if (existing && existing.contentLength === item.bytes.length && existing.sha256 === item.sha256) {
        log(`Unchanged immutable asset, skipped: ${item.objectKey}`)
        skippedKeys.push(item.objectKey)
        continue
      }
    }
    log(`Uploading ${item.objectKey} (${item.bytes.length} bytes, ${item.contentType})...`)
    await client.putBuffer(item.objectKey, item.bytes, {
      contentType: item.contentType,
      cacheControl: item.cacheControl,
      metadata: { sha256: item.sha256 },
    })
    uploadedKeys.push(item.objectKey)
  }

  // 3. Verify anonymous public HTTPS access with zero redirects (`redirect: 'manual'`).
  if (!skipVerify) {
    const verifyRes = await fetchImpl(indexUrl, { method: 'GET', redirect: 'manual' })
    if (verifyRes.status !== 200) {
      throw new Error(`Public verification of ${indexUrl} expected HTTP 200 (no redirect), got ${verifyRes.status}`)
    }
    const contentType = verifyRes.headers.get('content-type') ?? ''
    if (!contentType.toLowerCase().includes('application/json')) {
      throw new Error(`Public verification of ${indexUrl} expected application/json Content-Type, got ${JSON.stringify(contentType)}`)
    }
    const remoteBytes = Buffer.from(await verifyRes.arrayBuffer())
    const expectedSha = plan.at(-1).sha256
    if (sha256Hex(remoteBytes) !== expectedSha) {
      throw new Error(`Public verification of ${indexUrl} failed: remote SHA-256 does not match local site/index.json`)
    }
    const remoteParsed = parseMarketIndex(JSON.parse(remoteBytes.toString('utf8')), indexUrl)

    for (const plugin of remoteParsed.plugins) {
      if (!plugin.icon || !plugin.icon.startsWith(resolvedPublicBase)) continue
      const iconRes = await fetchImpl(plugin.icon, { method: 'HEAD', redirect: 'manual' })
      if (iconRes.status !== 200) {
        throw new Error(`Public verification of icon ${plugin.icon} expected HTTP 200 (no redirect), got ${iconRes.status}`)
      }
    }
  }

  log(`Published DSH plugin index (${parsed.plugins.length} plugins): ${indexUrl}`)
  return {
    dryRun: false,
    indexUrl,
    catalogUrl,
    pluginCount: parsed.plugins.length,
    uploadedKeys,
    skippedKeys,
    plannedKeys: plan.map((item) => item.objectKey),
  }
}

async function loadOptionalEnvFile(envFilePath) {
  const result = {}
  if (!envFilePath) return result
  const raw = await readFile(envFilePath, 'utf8')
  for (const line of raw.split(/\r?\n/u)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/u.exec(line)
    if (m) result[m[1]] = m[2].replace(/^["']|["']$/gu, '')
  }
  return result
}

async function runCli(argv) {
  const opts = {
    siteDir: 'site',
    bucket: process.env.DSH_INDEX_OSS_BUCKET || process.env.MINDECK_OSS_BUCKET || DEFAULT_OSS_BUCKET,
    region: process.env.DSH_INDEX_OSS_REGION || process.env.MINDECK_OSS_REGION || DEFAULT_OSS_REGION,
    prefix: process.env.DSH_INDEX_OSS_PREFIX || DEFAULT_OSS_PREFIX,
    publicBaseUrl: process.env.DSH_INDEX_PUBLIC_BASE_URL || '',
    envFile: '',
    dryRun: false,
    skipVerify: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--site-dir') opts.siteDir = argv[++i] ?? ''
    else if (arg === '--bucket') opts.bucket = argv[++i] ?? ''
    else if (arg === '--region') opts.region = argv[++i] ?? ''
    else if (arg === '--prefix') opts.prefix = argv[++i] ?? ''
    else if (arg === '--public-base-url') opts.publicBaseUrl = argv[++i] ?? ''
    else if (arg === '--env-file') opts.envFile = argv[++i] ?? ''
    else if (arg === '--dry-run') opts.dryRun = true
    else if (arg === '--skip-verify') opts.skipVerify = true
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write(
        'Usage: node scripts/publish-oss.mjs [--site-dir site] [--bucket <name>] [--region <region>] [--prefix <prefix>] [--public-base-url <url>] [--env-file <path>] [--dry-run] [--skip-verify]\n',
      )
      return
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }
  const fileEnv = await loadOptionalEnvFile(opts.envFile)
  const accessKeyId =
    process.env.ALIYUN_OSS_ACCESS_KEY_ID ||
    process.env.ALIYUN_ACCESS_KEY_ID ||
    fileEnv.ALIYUN_OSS_ACCESS_KEY_ID ||
    fileEnv.ALIYUN_ACCESS_KEY_ID ||
    ''
  const accessKeySecret =
    process.env.ALIYUN_OSS_ACCESS_KEY_SECRET ||
    process.env.ALIYUN_ACCESS_KEY_SECRET ||
    fileEnv.ALIYUN_OSS_ACCESS_KEY_SECRET ||
    fileEnv.ALIYUN_ACCESS_KEY_SECRET ||
    ''

  await publishPluginIndexToOss({
    ...opts,
    accessKeyId,
    accessKeySecret,
  })
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  runCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
