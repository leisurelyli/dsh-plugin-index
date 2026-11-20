#!/usr/bin/env node
/**
 * Standalone DSH Format-1 Plugin Market Index Generator.
 * Zero external runtime dependencies — runs natively on Node.js 24+.
 *
 * Reads `plugins.txt` (npm package names & https Git repo URLs) + `overrides.json`
 * (market title/description, categories, labels, optional per-plugin metadata),
 * fetches live metadata from npm / Git without running any package code, validates
 * the output against Format 1, and writes:
 *   - `site/index.json`
 *   - `site/icons/*` (icons larger than `--inline-icon-bytes`)
 *   - `site/index.html` (static catalog page)
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, posix, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { MAX_INLINE_ICON_BYTES, parseMarketIndex } from './lib/format1.mjs'
import { renderCatalogHtml } from './lib/html-catalog.mjs'
import { deriveDshRange, isExactSemver, rcompareSemver } from './lib/semver.mjs'
import { matchesIntegrity, PackageFiles, unpackTgz } from './lib/tar.mjs'

const execFileAsync = promisify(execFile)

export const PUBLIC_NPM_REGISTRY = 'https://registry.npmjs.org/'
const VALIDATION_URL = 'https://index.invalid/index.json'
const CACHE_VERSION = 1
const MAX_TARBALL_BYTES = 64 * 1024 * 1024
const MAX_ICON_BYTES = 256 * 1024
const GENERATED_ICON_RE = /^[0-9a-f]{16}\.(?:svg|png|jpg|jpeg|webp)$/u
const LANGUAGE_ID_RE = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u
const PATH_SEGMENT_RE = /^[A-Za-z0-9._@+-]+$/u
const ICON_MIME_BY_EXT = new Map([
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
])
const EXPORT_CONDITIONS = new Set(['import', 'node', 'default'])
const SCAN_DEPTH = 3
const SKIPPED_DIRS = new Set(['node_modules', 'test', 'tests', 'fixtures', 'examples', 'example'])

const METRIC_DECLARATIONS = {
  github_stars: { title: { en: 'GitHub stars', zh: 'GitHub 星标数' }, order: 'desc' },
  npm_weekly_downloads: { title: { en: 'npm weekly downloads', zh: 'npm 周下载量' }, order: 'desc' },
}

// ---------------------------------------------------------------------------
// File & cache helpers
// ---------------------------------------------------------------------------

function writeIfChanged(file, contents) {
  const bytes = Buffer.from(contents)
  if (existsSync(file) && readFileSync(file).equals(bytes)) return false
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`
  writeFileSync(tmp, bytes)
  renameSync(tmp, file)
  return true
}

function readJsonFile(file) {
  if (!existsSync(file)) return undefined
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

function cacheKey(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 24)
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyText(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

function isBundle(manifest) {
  const bundle = manifest?.dsh?.bundle
  if (!isObject(bundle)) return false
  return typeof bundle.patch === 'string'
    || (Array.isArray(bundle.patch) && bundle.patch.every((f) => typeof f === 'string'))
}

function isPrivate(manifest) {
  return manifest?.private === true
}

function invalidPlugins(plugins) {
  try {
    parseMarketIndex({ format: 1, title: 'check', plugins }, VALIDATION_URL)
    return undefined
  } catch (error) {
    return error.message
  }
}

class Cache {
  constructor(dir) {
    this.dir = dir
  }

  file(...identity) {
    return join(this.dir, 'results', `${cacheKey(JSON.stringify([CACHE_VERSION, ...identity]))}.json`)
  }

  usable(plugins) {
    return (
      invalidPlugins(plugins) === undefined
      && plugins.every(
        ({ icon }) =>
          icon === undefined
          || icon.startsWith('data:')
          || (icon.startsWith('icons/')
            && GENERATED_ICON_RE.test(icon.slice('icons/'.length))
            && existsSync(join(this.dir, icon))),
      )
    )
  }

  plugins(file) {
    const plugins = readJsonFile(file)?.plugins
    return Array.isArray(plugins) && this.usable(plugins) ? plugins : undefined
  }

  display(file) {
    const display = readJsonFile(file)?.display
    if (!display) return undefined
    const minimal = {
      ...display,
      name: 'placeholder',
      versions: [{ version: '0.0.0', publishTimestamp: 0, source: { type: 'npm' } }],
    }
    return this.usable([minimal]) ? display : undefined
  }

  release(file) {
    const data = readJsonFile(file)
    if (!data || !Object.hasOwn(data, 'release')) return undefined
    if (data.release === null) return null
    const rel = data.release
    return this.usable([entryOf(rel.name, [rel])]) ? rel : undefined
  }

  write(file, value, icons = []) {
    for (const icon of icons) writeIfChanged(join(this.dir, icon.path), icon.bytes)
    writeIfChanged(file, `${JSON.stringify(value)}\n`)
  }
}

// ---------------------------------------------------------------------------
// Package exports & display metadata extraction
// ---------------------------------------------------------------------------

function resolveConditionTarget(target) {
  if (typeof target === 'string') return target
  if (Array.isArray(target)) {
    for (const item of target) {
      const resolved = resolveConditionTarget(item)
      if (resolved !== undefined) return resolved
    }
    return undefined
  }
  if (isObject(target)) {
    for (const [cond, value] of Object.entries(target)) {
      if (EXPORT_CONDITIONS.has(cond)) {
        const resolved = resolveConditionTarget(value)
        if (resolved !== undefined) return resolved
      }
    }
  }
  return undefined
}

function resolveSubpath(manifest, subpath) {
  if (manifest.exports === undefined) return PackageFiles.resolve('', subpath)
  const exportsField = manifest.exports
  if (typeof exportsField === 'string') {
    return subpath === '.' ? PackageFiles.resolve('', exportsField) : undefined
  }
  if (!isObject(exportsField)) return undefined

  // Exact match
  if (Object.hasOwn(exportsField, subpath)) {
    const target = resolveConditionTarget(exportsField[subpath])
    return target === undefined ? undefined : PackageFiles.resolve('', target)
  }

  // Wildcard pattern match (`./locale/*.json`, etc.), longest prefix wins
  let best = null
  for (const [key, value] of Object.entries(exportsField)) {
    const star = key.indexOf('*')
    if (star === -1 || key.indexOf('*', star + 1) !== -1) continue
    const prefix = key.slice(0, star)
    const suffix = key.slice(star + 1)
    if (subpath.startsWith(prefix) && subpath.endsWith(suffix) && subpath.length >= prefix.length + suffix.length) {
      if (!best || prefix.length > best.prefix.length) {
        best = { prefix, suffix, value }
      }
    }
  }
  if (!best) return undefined
  const target = resolveConditionTarget(best.value)
  if (target === undefined) return undefined
  const matched = subpath.slice(best.prefix.length, best.suffix.length > 0 ? -best.suffix.length : undefined)
  return PackageFiles.resolve('', target.replaceAll('*', matched))
}

function parseLocaleFile(bytes) {
  let parsed
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString('utf8'))
  } catch (err) {
    return String(err)
  }
  if (!isObject(parsed)) return 'must be a JSON object'
  if (parsed.meta === undefined) return {}
  if (!isObject(parsed.meta)) return 'meta must be an object'
  const fields = {}
  for (const key of ['title', 'description']) {
    const val = parsed.meta[key]
    if (val === undefined) continue
    if (nonEmptyText(val) === undefined) return `meta.${key} must be a non-empty string`
    fields[key] = val
  }
  return fields
}

async function readLocaleDictionaries(files, manifest, warn) {
  const result = new Map()
  const english = resolveSubpath(manifest, './locale/en.json')
  if (english === undefined || files.file(english) === undefined) return result
  const dir = posix.dirname(english)
  const dirKey = dir === '.' ? '' : dir
  for (const name of files.fileNames(dirKey)) {
    if (!name.endsWith('.json')) continue
    const language = name.slice(0, -5)
    const lower = language.toLowerCase()
    const resolved = resolveSubpath(manifest, `./locale/${name}`)
    const bytes = resolved === undefined || posix.dirname(resolved) !== dir ? undefined : await files.read(resolved)
    const fields = !LANGUAGE_ID_RE.test(language)
      ? 'its name is not a language id'
      : result.has(lower)
        ? `duplicates locale ${lower}`
        : bytes === undefined
          ? `./locale/${name} does not resolve into ${dir}`
          : parseLocaleFile(bytes)
    if (typeof fields === 'string') warn(`locale file ${posix.join(dir, name)} ignored: ${fields}`)
    else result.set(lower, fields)
  }
  return result
}

function sortLocaleObject(mapObj) {
  const entries = Object.entries(mapObj).sort(([a], [b]) => {
    if (a === 'en') return -1
    if (b === 'en') return 1
    return a.localeCompare(b)
  })
  return Object.fromEntries(entries)
}

function buildLocalizedField(field, locales, fallback) {
  const translated = [...locales].flatMap(([lang, fields]) =>
    fields[field] === undefined ? [] : [[lang, fields[field]]],
  )
  if (translated.length === 0) return fallback
  const english = locales.get('en')?.[field] ?? fallback
  if (english === undefined) return undefined
  if (translated.length === 1 && translated[0][0] === 'en') return english
  return sortLocaleObject(Object.fromEntries([['en', english], ...translated]))
}

function normalizeRepositoryUrl(declared) {
  const clean = declared.replace(/#.*$/u, '').trim()

  // Hosted shorthands (`github:o/r`, `gitlab:o/r`, `bitbucket:o/r`, `o/r`)
  const shorthand = /^(?:(github|gitlab|bitbucket):)?([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/u.exec(clean)
  if (shorthand) {
    const hostMap = { github: 'github.com', gitlab: 'gitlab.com', bitbucket: 'bitbucket.org' }
    const host = hostMap[shorthand[1] ?? 'github']
    return `https://${host}/${shorthand[2]}`
  }

  // SCP-style SSH (`git@github.com:owner/repo.git`)
  const scp = /^(?:git\+)?(?:ssh:\/\/)?(?:[^@/\s]+@)?([A-Za-z0-9.-]+):([^/\s][^?\s#]*?)(?:\.git)?$/u.exec(clean)
  if (scp && !clean.startsWith('http://') && !clean.startsWith('https://')) {
    return `https://${scp[1]}/${scp[2]}`
  }

  const plain = clean.replace(/^git\+/u, '').replace(/^(?:git|ssh):\/\//u, 'https://')
  if (!URL.canParse(plain)) return undefined
  const url = new URL(plain)
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined
  url.username = ''
  url.password = ''
  url.search = ''
  url.hash = ''
  url.pathname = url.pathname.replace(/\.git$/u, '')
  return url.href
}

function readRepository(value, warn) {
  if (value === undefined) return undefined
  const obj = isObject(value) ? value : undefined
  const declared = nonEmptyText(obj === undefined ? value : obj.url)?.trim()
  const url = declared === undefined ? undefined : normalizeRepositoryUrl(declared)
  if (url === undefined) {
    warn(`package.json repository ${JSON.stringify(value)} names no http(s) repository page; omitted`)
    return undefined
  }
  const directory = nonEmptyText(obj?.directory)?.replace(/^\.\/|\/$/gu, '')
  const validDir =
    directory !== undefined
    && directory.split('/').every((seg) => seg !== '.' && seg !== '..' && PATH_SEGMENT_RE.test(seg))
  if (obj?.directory !== undefined && !validDir) {
    warn(`package.json repository.directory ${JSON.stringify(obj.directory)} is not a relative directory; omitted`)
  }
  return { url, ...(validDir ? { directory } : {}) }
}

async function readIcon(files, manifest) {
  let iconPath
  if (manifest.icon === undefined) {
    iconPath = resolveSubpath(manifest, './icon')
    if (iconPath === undefined || files.file(iconPath) === undefined) return undefined
  } else {
    const declared = nonEmptyText(manifest.icon)
    if (declared === undefined || /^[A-Za-z][A-Za-z\d+.-]*:/u.test(declared)) {
      return 'icon must be a relative file path'
    }
    iconPath = PackageFiles.resolve('', declared)
    if (iconPath === undefined) return `icon ${declared} is outside the package`
  }
  const ext = posix.extname(iconPath).toLowerCase()
  const mime = ICON_MIME_BY_EXT.get(ext)
  if (mime === undefined) return `icon ${iconPath} must be SVG, PNG, JPEG, or WebP`
  const file = files.file(iconPath)
  if (file === undefined) return `icon ${iconPath} is not a file in the package`
  if (file.size > MAX_ICON_BYTES) return `icon ${iconPath} exceeds 256 KiB`
  return { mime, ext, bytes: Buffer.from(await file.read()) }
}

async function readDisplayMetadata(files, manifest, { inlineBytes, warn }) {
  const locales = await readLocaleDictionaries(files, manifest, warn)
  const title = buildLocalizedField('title', locales, nonEmptyText(manifest.name))
  const description = buildLocalizedField('description', locales, nonEmptyText(manifest.description))

  const person = isObject(manifest.author) ? manifest.author.name : manifest.author
  const author = nonEmptyText(typeof person === 'string' ? person.replace(/<[^>]*>|\([^)]*\)/gu, '').trim() : person)

  const homepage = nonEmptyText(manifest.homepage)
  const linkable =
    homepage !== undefined && URL.canParse(homepage) && ['https:', 'http:'].includes(new URL(homepage).protocol)
  if (homepage !== undefined && !linkable) {
    warn(`package.json homepage ${JSON.stringify(homepage)} is not an http(s) URL; omitted`)
  }

  const repository = readRepository(manifest.repository, warn)
  const keywords =
    Array.isArray(manifest.keywords) && manifest.keywords.every((kw) => typeof kw === 'string')
      ? manifest.keywords
      : undefined
  if (manifest.keywords !== undefined && keywords === undefined) {
    warn('package.json keywords must be an array of strings; omitted')
  }

  const display = {
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
    ...(author === undefined ? {} : { author }),
    ...(linkable ? { homepage } : {}),
    ...(repository === undefined ? {} : { repository }),
    ...(keywords === undefined ? {} : { metadata: { keywords } }),
  }

  const icon = await readIcon(files, manifest)
  if (typeof icon === 'string') warn(`${icon}; omitted`)
  if (!isObject(icon)) return { display }

  if (icon.bytes.length <= inlineBytes) {
    return { display: { ...display, icon: `data:${icon.mime};base64,${icon.bytes.toString('base64')}` } }
  }
  const relFile = `icons/${createHash('sha256').update(icon.bytes).digest('hex').slice(0, 16)}${icon.ext}`
  return {
    display: { ...display, icon: relFile },
    iconFile: { path: relFile, bytes: icon.bytes },
  }
}

// ---------------------------------------------------------------------------
// Release / entry assembly
// ---------------------------------------------------------------------------

function entryOf(name, releases) {
  const sorted = [...releases].sort((a, b) => rcompareSemver(a.version.version, b.version.version))
  const { title, description, icon, author, homepage, repository, metadata } = sorted[0]?.display ?? {}
  return {
    name,
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
    ...(icon === undefined ? {} : { icon }),
    ...(author === undefined ? {} : { author }),
    ...(homepage === undefined ? {} : { homepage }),
    ...(repository === undefined ? {} : { repository }),
    ...(metadata === undefined ? {} : { metadata }),
    versions: sorted.map((r) => r.version),
  }
}

function releaseOf(name, manifest, version, publishTimestamp, source, warn) {
  const range = deriveDshRange(manifest)
  const release = {
    name,
    version: {
      version,
      publishTimestamp,
      source,
      ...(typeof range === 'string' ? { engines: { dsh: range } } : {}),
    },
  }
  const problem =
    range instanceof Error ? range.message : invalidPlugins([entryOf(name, [release])])?.replace('$.plugins[0]', 'entry')
  if (problem === undefined) return release
  warn(`${name}@${version} skipped: ${problem}`)
  return undefined
}

async function readManifestFromFiles(files, dir) {
  const bytes = await files.read(posix.join(dir, 'package.json'))
  if (bytes === undefined) return undefined
  try {
    const parsed = JSON.parse(Buffer.from(bytes).toString('utf8'))
    return isObject(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// npm fetcher
// ---------------------------------------------------------------------------

async function fetchWithRetry(url, init, { timeoutMs, retries = 2 }) {
  let lastErr
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
      if (res.status >= 500 && attempt < retries) {
        await res.body?.cancel()
        await new Promise((r) => setTimeout(r, 300 * (attempt + 1)))
        continue
      }
      return res
    } catch (err) {
      lastErr = err
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 300 * (attempt + 1)))
        continue
      }
      throw lastErr
    }
  }
  throw lastErr
}

async function fetchNpmPackument(registry, name, timeoutMs) {
  const url = new URL(name.replace('/', '%2f'), registry)
  const res = await fetchWithRetry(url, { headers: { Accept: 'application/json' } }, { timeoutMs })
  if (!res.ok) throw new Error(`${name}: registry answered HTTP ${res.status}`)
  return await res.json()
}

async function fetchNpmTarball(name, version, dist, timeoutMs) {
  const label = `${name}@${version}`
  if (typeof dist?.tarball !== 'string' || typeof dist.integrity !== 'string') {
    throw new Error(`${label}: registry lists no tarball with integrity`)
  }
  const res = await fetch(dist.tarball, { signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) throw new Error(`${label}: tarball answered HTTP ${res.status}`)
  const chunks = []
  let total = 0
  for await (const chunk of res.body) {
    total += chunk.length
    if (total > MAX_TARBALL_BYTES) throw new Error(`${label}: tarball exceeds ${MAX_TARBALL_BYTES} bytes`)
    chunks.push(chunk)
  }
  const bytes = Buffer.concat(chunks)
  if (!matchesIntegrity(bytes, dist.integrity)) {
    throw new Error(`${label}: tarball does not match its registry integrity`)
  }
  const files = unpackTgz(bytes, label, MAX_TARBALL_BYTES)
  const manifest = await readManifestFromFiles(files, '')
  if (manifest?.name !== name || manifest.version !== version) {
    throw new Error(`${label}: tarball package.json does not name ${label}`)
  }
  return { files, manifest }
}

async function readNpmSource(source, options, cache) {
  const packument = await fetchNpmPackument(options.registry, source.name, options.timeoutMs)
  const npmSource = { type: 'npm', ...(options.recordRegistry ? { registry: options.registry } : {}) }
  const warn = (msg) => options.warn(`${source.line}: ${msg}`)

  const releases = Object.entries(packument.versions ?? {}).flatMap(([version, manifest]) => {
    const published = packument.time?.[version]
    const deprecated = typeof manifest.deprecated === 'string' && manifest.deprecated !== ''
    if (deprecated || isPrivate(manifest) || !isBundle(manifest) || typeof published !== 'string') return []
    const ts = Math.floor(Date.parse(published) / 1000)
    return releaseOf(source.name, manifest, version, ts, npmSource, warn) ?? []
  })

  const highest = entryOf(source.name, releases).versions[0]?.version
  if (highest === undefined) {
    warn('no published version that is neither deprecated nor private declares dsh.bundle')
    return []
  }

  const cacheFile = cache.file(
    'npm',
    options.registry,
    options.recordRegistry,
    options.inlineIconBytes,
    source.name,
    releases.map((r) => r.version.version).sort(),
  )
  const cached = cache.plugins(cacheFile)
  if (cached !== undefined) return cached

  const { files, manifest } = await fetchNpmTarball(
    source.name,
    highest,
    packument.versions?.[highest]?.dist,
    options.timeoutMs,
  )
  const icons = []
  const { display, iconFile } = await readDisplayMetadata(files, manifest, {
    inlineBytes: options.inlineIconBytes,
    warn: (msg) => options.warn(`${source.name}@${highest}: ${msg}`),
  })
  if (iconFile) icons.push(iconFile)

  const plugins = [
    entryOf(
      source.name,
      releases.map((r) => (r.version.version === highest ? { ...r, display } : r)),
    ),
  ]
  cache.write(cacheFile, { plugins }, icons)
  return plugins
}

// ---------------------------------------------------------------------------
// Git fetcher (safe bare-repo blob reader, zero working tree checkout)
// ---------------------------------------------------------------------------

function gitEnv() {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !name.startsWith('GIT_') || name === 'GIT_SSH' || name === 'GIT_SSH_COMMAND',
    ),
  )
  const ssh = env.GIT_SSH === undefined && env.GIT_SSH_COMMAND === undefined ? { GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' } : {}
  return { ...env, GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1', ...ssh }
}

function runGit(args, timeoutMs, cwd, input) {
  const safety = [
    'core.hooksPath=/dev/null',
    'core.fsmonitor=false',
    'submodule.recurse=false',
    'gc.auto=0',
    'maintenance.auto=false',
    'protocol.allow=never',
    'protocol.https.allow=always',
    'protocol.ssh.allow=always',
  ].flatMap((s) => ['-c', s])
  const promise = execFileAsync('git', [...safety, ...args], {
    cwd,
    env: gitEnv(),
    timeout: timeoutMs,
    encoding: 'buffer',
    maxBuffer: 256 * 1024 * 1024,
  })
  promise.child.stdin?.on('error', () => {})
  promise.child.stdin?.end(input ?? '')
  return promise
}

async function readGitRefs(url, timeoutMs) {
  const { stdout } = await runGit(['ls-remote', '--', url, 'HEAD', 'refs/tags/*'], timeoutMs)
  let head
  const tags = new Map()
  for (const [, commit, ref] of stdout.toString('utf8').matchAll(/^([0-9a-f]{40})\t(\S+)$/gmu)) {
    if (ref === 'HEAD') head = commit
    const tag = /^refs\/tags\/(.+?)(\^\{\})?$/u.exec(ref)
    if (tag) tags.set(tag[1], commit)
  }
  if (!head) throw new Error(`${url}: no HEAD commit`)
  return { head, tags }
}

function parseReleaseTag(tag, commit) {
  const m = /^(?:(?<name>.+)@|v)?(?<version>[^@]+)$/u.exec(tag)?.groups
  if (!m || !isExactSemver(m.version)) return undefined
  return { tag, commit, version: m.version, ...(m.name === undefined ? {} : { name: m.name }) }
}

async function findBundlePackages(files) {
  const rootManifest = await readManifestFromFiles(files, '')
  if (isBundle(rootManifest)) return ['']
  const found = []
  const walk = async (rel, depth) => {
    for (const dir of files.directories(rel)) {
      if (dir.startsWith('.') || SKIPPED_DIRS.has(dir)) continue
      const child = posix.join(rel, dir)
      if (isBundle(await readManifestFromFiles(files, child))) found.push(child)
      else if (depth < SCAN_DEPTH) await walk(child, depth + 1)
    }
  }
  await walk('', 1)
  return found.sort()
}

async function readGitSource(source, options, cache) {
  const refs = await readGitRefs(source.url, options.timeoutMs)
  const tags = [...refs.tags].flatMap(([tag, commit]) => parseReleaseTag(tag, commit) ?? [])
  const cacheFile = cache.file(
    'git',
    options.inlineIconBytes,
    source.url,
    refs.head,
    tags.map((t) => [t.tag, t.commit]),
  )
  const cached = cache.plugins(cacheFile)
  if (cached !== undefined) return cached

  const warn = (msg) => options.warn(`${source.line}: ${msg}`)
  const unitFile = (kind, commit, dir) => cache.file(kind, options.inlineIconBytes, source.url, commit, dir)
  const dir = mkdtempSync(join(tmpdir(), 'dsh-index-git-'))
  const inRepo = (args, input) => runGit(args, options.timeoutMs, dir, input)
  const refNames = new Map([...[...refs.tags].map(([t, c]) => [c, `refs/tags/${t}`]), [refs.head, 'HEAD']])
  const fetched = new Set()

  const fetchCommits = async (commits) => {
    const wanted = [...new Set(commits)].filter((c) => !fetched.has(c))
    if (wanted.length === 0) return
    const doFetch = (targets) =>
      inRepo(['fetch', '--quiet', '--depth', '1', '--no-tags', '--stdin', '--', source.url], `${targets.join('\n')}\n`)
    await doFetch(wanted).catch(() => doFetch(wanted.map((c) => refNames.get(c))))
    for (const c of wanted) fetched.add(c)
  }

  const listTree = async (commit, subPath) => {
    await fetchCommits([commit])
    const scope = subPath === '' ? [] : ['--', `${subPath}/`]
    const listing = (await inRepo(['ls-tree', '-r', '-l', '-z', '--full-tree', commit, ...scope])).stdout.toString('utf8')
    const prefix = subPath === '' ? '' : `${subPath}/`
    const fileMap = new Map()
    for (const line of listing.split('\0')) {
      const m = /^100(?:644|755) blob (?<blob>[0-9a-f]+) +(?<size>\d+)\t(?<file>.+)$/su.exec(line)?.groups
      if (!m) continue
      fileMap.set(m.file.slice(prefix.length), {
        size: Number(m.size),
        read: async () => (await inRepo(['cat-file', 'blob', m.blob])).stdout,
      })
    }
    return new PackageFiles(fileMap)
  }

  const committedAt = async (commit) => {
    const header = (await inRepo(['cat-file', 'commit', commit])).stdout.toString('utf8')
    const m = /^committer .* (\d+) [+-]\d{4}$/mu.exec(header)
    if (!m) throw new Error(`${commit}: commit has no committer time`)
    return Number(m[1])
  }

  try {
    await inRepo(['init', '--quiet', '--bare'])
    const headTree = await listTree(refs.head, '')
    const pkgPaths = await findBundlePackages(headTree)
    if (pkgPaths.length === 0) warn('no package declares dsh.bundle')
    const packages = []
    for (const p of pkgPaths) {
      const manifest = await readManifestFromFiles(headTree.within(p), '')
      if (!isPrivate(manifest) && typeof manifest?.name === 'string') {
        packages.push({ path: p, name: manifest.name })
      }
    }

    const units = [
      ...tags.flatMap((tag) =>
        packages
          .filter((found) => tag.name === undefined || tag.name === found.name)
          .map((found) => ({ found, commit: tag.commit, version: tag.version, rank: tag.name === undefined ? 1 : 0 })),
      ),
      ...packages.map((found) => ({ found, commit: refs.head, version: undefined, rank: 2 })),
    ].map((u) => ({ ...u, file: unitFile('release', u.commit, u.found.path) }))

    const cachedRel = new Map(units.map((u) => [u.file, cache.release(u.file)]))
    await fetchCommits(units.flatMap((u) => (cachedRel.get(u.file) === undefined ? [u.commit] : [])))

    const seenRel = new Map()
    const candidates = []
    for (const u of units) {
      let rel = seenRel.has(u.file) ? seenRel.get(u.file) : cachedRel.get(u.file)
      if (rel === undefined) {
        try {
          const files = await listTree(u.commit, u.found.path)
          const manifest = await readManifestFromFiles(files, '')
          const gitSrc = { type: 'git', url: source.url, commit: u.commit, ...(u.found.path ? { path: u.found.path } : {}) }
          rel =
            isBundle(manifest) && !isPrivate(manifest) && typeof manifest?.name === 'string' && typeof manifest.version === 'string'
              ? releaseOf(manifest.name, manifest, manifest.version, await committedAt(u.commit), gitSrc, warn) ?? null
              : null
        } catch (err) {
          warn(`${u.commit}:${u.found.path} skipped: ${err.message}`)
          rel = null
        }
        cache.write(u.file, { release: rel })
      }
      seenRel.set(u.file, rel)
      if (rel?.name === u.found.name && (u.version ?? rel.version.version) === rel.version.version) {
        candidates.push({ release: rel, rank: u.rank, path: u.found.path })
      }
    }

    candidates.sort((a, b) => a.rank - b.rank || a.release.version.publishTimestamp - b.release.version.publishTimestamp)
    const chosen = new Map(packages.map((p) => [p.name, new Map()]))
    for (const c of candidates) {
      const m = chosen.get(c.release.name)
      if (!m.has(c.release.version.version)) m.set(c.release.version.version, c)
    }

    const entries = []
    for (const [name, versionMap] of chosen) {
      const highest = entryOf(name, [...versionMap.values()].map((v) => v.release)).versions[0]
      if (!highest) continue
      const { path: pkgDir } = versionMap.get(highest.version)
      const dispFile = unitFile('display', highest.source.commit, pkgDir)
      let display = cache.display(dispFile)
      if (!display) {
        const files = await listTree(highest.source.commit, pkgDir)
        const manifest = await readManifestFromFiles(files, '')
        const icons = []
        const res = await readDisplayMetadata(files, manifest, {
          inlineBytes: options.inlineIconBytes,
          warn: (msg) => options.warn(`${name}@${highest.version}: ${msg}`),
        })
        display = res.display
        if (res.iconFile) icons.push(res.iconFile)
        cache.write(dispFile, { display }, icons)
      }
      const listed = [...versionMap.values()].map(({ release }) =>
        release.version === highest ? { ...release, display } : release,
      )
      entries.push(entryOf(name, listed))
    }
    cache.write(cacheFile, { plugins: entries })
    return entries
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// Source list parser, overrides merger & metrics fetcher
// ---------------------------------------------------------------------------

export function parseSources(text) {
  const sources = []
  const seen = new Set()
  for (const [index, raw] of text.split(/\r?\n/u).entries()) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    let source
    try {
      if (line.includes('://')) {
        const url = URL.canParse(line) ? new URL(line).href.replace(/\/+$/u, '').replace(/\.git$/u, '') : line
        parseMarketIndex(
          { format: 1, title: 'check', plugins: [{ name: 'placeholder', versions: [{ version: '0.0.0', publishTimestamp: 0, source: { type: 'git', url, commit: '0'.repeat(40) } }] }] },
          VALIDATION_URL,
        )
        source = { kind: 'git', line, url }
      } else {
        parseMarketIndex(
          { format: 1, title: 'check', plugins: [{ name: line, versions: [{ version: '0.0.0', publishTimestamp: 0, source: { type: 'npm' } }] }] },
          VALIDATION_URL,
        )
        source = { kind: 'npm', line, name: line }
      }
    } catch (error) {
      throw new Error(`line ${index + 1}: invalid source (${error.reason ?? error.message}): ${line}`)
    }
    const key = source.kind === 'npm' ? `npm:${source.name}` : `git:${source.url}`
    if (seen.has(key)) continue
    seen.add(key)
    sources.push(source)
  }
  return sources
}

function mergeLocalized(base, override) {
  if (override === undefined) return base
  if (typeof override === 'string') return override
  const baseMap = typeof base === 'string' ? { en: base } : isObject(base) ? { ...base } : {}
  const merged = { ...baseMap, ...override }
  return sortLocaleObject(merged)
}

function applyPluginOverride(entry, override) {
  if (!override) return entry
  const title = mergeLocalized(entry.title, override.title)
  const description = mergeLocalized(entry.description, override.description)
  const keywords = override.keywords ?? entry.metadata?.keywords
  const labels = Array.isArray(override.labels) ? [...new Set(override.labels)] : undefined
  const metadata = {
    ...(override.category !== undefined ? { category: override.category } : {}),
    ...(keywords !== undefined ? { keywords } : {}),
    ...(labels !== undefined && labels.length > 0 ? { labels } : {}),
    ...(entry.metadata?.sortKeys !== undefined ? { sortKeys: entry.metadata.sortKeys } : {}),
  }
  return {
    name: entry.name,
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
    ...(entry.icon === undefined ? {} : { icon: entry.icon }),
    ...(entry.author === undefined ? {} : { author: entry.author }),
    ...(entry.homepage === undefined ? {} : { homepage: entry.homepage }),
    ...(entry.repository === undefined ? {} : { repository: entry.repository }),
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    versions: entry.versions,
  }
}

function createMetricReader({ timeoutMs, allowNpmDownloads, githubToken, warn }) {
  const inFlight = new Map()
  async function fetchCount(url, field) {
    const auth = githubToken !== undefined && new URL(url).origin === 'https://api.github.com'
    try {
      const res = await fetchWithRetry(
        url,
        {
          headers: auth
            ? { Authorization: `Bearer ${githubToken}`, 'User-Agent': 'dsh-plugin-index' }
            : { 'User-Agent': 'dsh-plugin-index' },
        },
        { timeoutMs },
      )
      if (!res.ok) {
        await res.body?.cancel()
        warn(`${url}: HTTP ${res.status}; metric omitted`)
        return undefined
      }
      const data = await res.json()
      const val = isObject(data) ? data[field] : undefined
      if (typeof val === 'number' && Number.isSafeInteger(val) && val >= 0) return val
      warn(`${url}: ${field} is not a non-negative safe integer; metric omitted`)
      return undefined
    } catch (err) {
      warn(`${url}: ${auth ? 'GitHub metric request failed' : err.message}; metric omitted`)
      return undefined
    }
  }
  const shared = (url, field) => {
    if (!inFlight.has(url)) inFlight.set(url, fetchCount(url, field))
    return inFlight.get(url)
  }

  return async (entry) => {
    const sortKeys = {}
    const topSrc = entry.versions[0]?.source
    const repoUrl = topSrc?.type === 'git' ? topSrc.url : entry.repository?.url
    if (githubToken !== undefined && repoUrl) {
      const parsed = new URL(repoUrl)
      const m = parsed.hostname === 'github.com' ? /^\/([^/]+)\/([^/]+?)\/?$/u.exec(parsed.pathname) : null
      if (m) {
        const stars = await shared(
          `https://api.github.com/repos/${m[1]}/${m[2].replace(/\.git$/u, '')}`,
          'stargazers_count',
        )
        if (stars !== undefined) sortKeys.github_stars = stars
      }
    }
    if (allowNpmDownloads && entry.versions.some((v) => v.source.type === 'npm')) {
      const dl = await shared(
        `https://api.npmjs.org/downloads/point/last-week/${encodeURIComponent(entry.name)}`,
        'downloads',
      )
      if (dl !== undefined) sortKeys.npm_weekly_downloads = dl
    }
    if (Object.keys(sortKeys).length === 0) return entry
    return {
      ...entry,
      metadata: { ...(entry.metadata ?? {}), sortKeys },
    }
  }
}

async function mapLimited(items, limit, work) {
  const results = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const idx = next++
      results[idx] = await work(items[idx], idx)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

// ---------------------------------------------------------------------------
// Main CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    input: 'plugins.txt',
    overrides: 'overrides.json',
    output: 'site/index.json',
    cache: '.plugin-market-cache',
    registry: PUBLIC_NPM_REGISTRY,
    recordRegistry: undefined,
    inlineIconBytes: 16384,
    concurrency: 4,
    timeoutMs: 60000,
    html: true,
    help: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`missing value for ${arg}`)
      return argv[++i]
    }
    if (arg === '-h' || arg === '--help') opts.help = true
    else if (arg === '--input') opts.input = next()
    else if (arg === '--overrides') opts.overrides = next()
    else if (arg === '--output') opts.output = next()
    else if (arg === '--cache') opts.cache = next()
    else if (arg === '--registry') opts.registry = next()
    else if (arg === '--no-record-registry') opts.recordRegistry = false
    else if (arg === '--record-registry') opts.recordRegistry = true
    else if (arg === '--no-html') opts.html = false
    else if (arg === '--inline-icon-bytes') {
      const n = Number(next())
      if (!Number.isInteger(n) || n < 0 || n > MAX_INLINE_ICON_BYTES) {
        throw new Error(`--inline-icon-bytes must be an integer between 0 and ${MAX_INLINE_ICON_BYTES}`)
      }
      opts.inlineIconBytes = n
    } else if (arg === '--concurrency') {
      const n = Number(next())
      if (!Number.isInteger(n) || n < 1) throw new Error('--concurrency must be a positive integer')
      opts.concurrency = n
    } else if (arg === '--timeout-ms') {
      const n = Number(next())
      if (!Number.isInteger(n) || n < 1000) throw new Error('--timeout-ms must be an integer >= 1000')
      opts.timeoutMs = n
    } else {
      throw new Error(`unknown argument: ${arg}`)
    }
  }
  return opts
}

function printHelp() {
  console.log(`Usage: node scripts/build-index.mjs [options]

Options:
  --input <file>            Source list (default: plugins.txt)
  --overrides <file>        Curated market metadata & overrides (default: overrides.json)
  --output <file>           Output index JSON path (default: site/index.json)
  --cache <dir>             Result cache directory (default: .plugin-market-cache)
  --registry <url>          npm registry URL (default: ${PUBLIC_NPM_REGISTRY})
  --no-record-registry      Fetch via mirror registry without writing registry into index.json
  --inline-icon-bytes <n>   Max bytes to inline as data URL, up to ${MAX_INLINE_ICON_BYTES} (default: 16384)
  --concurrency <n>         Concurrent fetches (default: 4)
  --timeout-ms <n>          Request timeout in ms (default: 60000)
  --no-html                 Skip generating site/index.html catalog page
  -h, --help                Show this help

Environment:
  GITHUB_TOKEN              Optional GitHub API token to also collect github_stars sortKey.

Exit codes:
  0  Every source read successfully and output validated.
  1  One or more sources failed (kept cached fallback where available).
  2  Invalid CLI arguments, input list, or overrides file.`)
}

export async function runBuild(argv = process.argv.slice(2)) {
  let opts
  try {
    opts = parseArgs(argv)
  } catch (err) {
    console.error(`error: ${err.message}`)
    return 2
  }
  if (opts.help) {
    printHelp()
    return 0
  }

  const cwd = process.cwd()
  const inputPath = resolve(cwd, opts.input)
  const overridesPath = resolve(cwd, opts.overrides)
  const outputPath = resolve(cwd, opts.output)
  const cacheDir = resolve(cwd, opts.cache)

  let registry
  let sources
  let overrides = {}
  try {
    registry = new URL(opts.registry).href.replace(/\/?$/u, '/')
    sources = parseSources(readFileSync(inputPath, 'utf8'))
    if (existsSync(overridesPath)) {
      overrides = JSON.parse(readFileSync(overridesPath, 'utf8'))
    }
  } catch (err) {
    console.error(`error: ${err.message}`)
    return 2
  }

  const recordRegistry = opts.recordRegistry ?? registry !== PUBLIC_NPM_REGISTRY
  const githubToken = process.env.GITHUB_TOKEN?.trim() || undefined
  const warn = (msg) => console.error(`warning: ${msg}`)
  const cache = new Cache(cacheDir)

  const genOpts = {
    registry,
    recordRegistry,
    inlineIconBytes: opts.inlineIconBytes,
    timeoutMs: opts.timeoutMs,
    warn,
  }

  const failures = []
  const perSource = await mapLimited(sources, opts.concurrency, async (source) => {
    const lastFile = join(
      cacheDir,
      'last',
      `${cacheKey(JSON.stringify([CACHE_VERSION, registry, recordRegistry, opts.inlineIconBytes, source.line]))}.json`,
    )
    try {
      const entries =
        source.kind === 'npm'
          ? await readNpmSource(source, genOpts, cache)
          : await readGitSource(source, genOpts, cache)
      cache.write(lastFile, { plugins: entries })
      return entries
    } catch (err) {
      const msg = `${source.line}: ${err.message}`
      const last = cache.plugins(lastFile)
      failures.push(msg)
      warn(last ? `${msg}; keeping last successful cached result` : msg)
      return last ?? []
    }
  })

  // Deduplicate keeping first occurrence in source-list order
  const seenNames = new Set()
  const rawPlugins = []
  const iconsToCopy = new Map()
  for (const entry of perSource.flat()) {
    if (seenNames.has(entry.name)) {
      warn(`${entry.name}: listed by more than one source; keeping first`)
      continue
    }
    seenNames.add(entry.name)
    rawPlugins.push(entry)
    if (entry.icon?.startsWith('icons/')) {
      iconsToCopy.set(entry.icon, join(cacheDir, entry.icon))
    }
  }

  // Fetch popularity metrics (npm_weekly_downloads + optional github_stars)
  const allowNpmDownloads = registry === PUBLIC_NPM_REGISTRY || !recordRegistry
  const readMetrics = createMetricReader({
    timeoutMs: opts.timeoutMs,
    allowNpmDownloads,
    githubToken,
    warn,
  })
  const measured = await mapLimited(rawPlugins, opts.concurrency, readMetrics)

  // Merge curated overrides (category, labels, localized title/description)
  const pluginOverrides = isObject(overrides.plugins) ? overrides.plugins : {}
  const plugins = measured.map((entry) => applyPluginOverride(entry, pluginOverrides[entry.name]))

  // Build root metadata declarations
  const categories = isObject(overrides.categories) && Object.keys(overrides.categories).length > 0
    ? overrides.categories
    : undefined
  const labels = isObject(overrides.labels) && Object.keys(overrides.labels).length > 0
    ? overrides.labels
    : undefined
  const sortKeysEntries = Object.entries(METRIC_DECLARATIONS).filter(([id]) =>
    plugins.some((p) => Object.hasOwn(p.metadata?.sortKeys ?? {}, id)),
  )
  const sortKeys = sortKeysEntries.length > 0 ? Object.fromEntries(sortKeysEntries) : undefined
  const metadata = {
    ...(categories ? { categories } : {}),
    ...(labels ? { labels } : {}),
    ...(sortKeys ? { sortKeys } : {}),
  }

  const index = {
    format: 1,
    title: overrides.title ?? { en: 'Curated DSH Plugin Index', zh: 'DSH 精选插件市场' },
    ...(overrides.description !== undefined ? { description: overrides.description } : {}),
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    plugins,
  }

  // Strict Format 1 self-validation before writing anything to site/
  parseMarketIndex(index, VALIDATION_URL)

  const outDir = dirname(outputPath)
  for (const [relIcon, cachedPath] of iconsToCopy) {
    writeIfChanged(join(outDir, relIcon), readFileSync(cachedPath))
  }
  // Remove stale generated icons
  const iconDir = join(outDir, 'icons')
  if (existsSync(iconDir)) {
    for (const file of readdirSync(iconDir)) {
      const full = join(iconDir, file)
      if (GENERATED_ICON_RE.test(file) && !iconsToCopy.has(`icons/${file}`) && lstatSync(full).isFile()) {
        rmSync(full, { force: true })
      }
    }
  }

  const jsonChanged = writeIfChanged(outputPath, `${JSON.stringify(index, null, 2)}\n`)
  console.log(
    `${jsonChanged ? 'wrote' : 'unchanged'} ${outputPath}: ${plugins.length} plugin(s), ${iconsToCopy.size} external icon(s), ${failures.length} failed source(s)`,
  )

  if (opts.html) {
    const htmlPath = join(outDir, 'index.html')
    const htmlChanged = writeIfChanged(htmlPath, renderCatalogHtml(index))
    console.log(`${htmlChanged ? 'wrote' : 'unchanged'} ${htmlPath}`)
  }

  return failures.length === 0 ? 0 : 1
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  runBuild().then((code) => {
    process.exitCode = code
  })
}
