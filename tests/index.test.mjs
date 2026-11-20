import assert from 'node:assert/strict'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  MarketIndexError,
  marketInstallTarget,
  MAX_INLINE_ICON_BYTES,
  parseMarketIndex,
} from '../scripts/lib/format1.mjs'
import { deriveDshRange, isExactSemver, isValidRange, rcompareSemver, satisfiesRange } from '../scripts/lib/semver.mjs'
import { createStaticServer } from '../scripts/serve.mjs'
import {
  encodeOssKey,
  planSiteUploads,
  publishPluginIndexToOss,
  signOssRequest,
} from '../scripts/publish-oss.mjs'
import { validateIndexFile } from '../scripts/validate-index.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SITE_DIR = resolve(ROOT, 'site')
const INDEX_PATH = resolve(SITE_DIR, 'index.json')
const HTML_PATH = resolve(SITE_DIR, 'index.html')

describe('Generated site/index.json (DSH Format 1)', () => {
  it('exists and passes strict Format 1 validation', () => {
    assert.ok(existsSync(INDEX_PATH), 'site/index.json must exist — run `npm run build` first')
    const { raw, parsed } = validateIndexFile(INDEX_PATH, 'https://example.invalid/dsh-plugin-index/index.json')

    assert.equal(parsed.format, 1)
    assert.ok(parsed.plugins.length >= 5, `expected at least 5 curated plugins, got ${parsed.plugins.length}`)
    assert.equal(typeof parsed.title, 'object')
    assert.ok(parsed.title.en && parsed.title.en.trim().length > 0, 'root title.en is required')
    assert.ok(parsed.title.zh && parsed.title.zh.trim().length > 0, 'root title.zh should be present')
    assert.ok(Object.keys(parsed.metadata.categories).length >= 5, 'categories should be declared')
    assert.ok(Object.keys(parsed.metadata.labels).length >= 2, 'labels should be declared')
    assert.ok(raw.plugins.length === parsed.plugins.length)
  })

  it('has valid SemVer versions in descending order, valid sources, engines.dsh, and localized strings', () => {
    const raw = JSON.parse(readFileSync(INDEX_PATH, 'utf8'))
    const parsed = parseMarketIndex(raw, 'https://example.invalid/index.json')

    for (let i = 0; i < raw.plugins.length; i++) {
      const p = raw.plugins[i]
      const vp = parsed.plugins[i]

      // Localized strings must contain `en` when object form
      for (const field of ['title', 'description']) {
        if (p[field] && typeof p[field] === 'object') {
          assert.ok(typeof p[field].en === 'string' && p[field].en.trim() !== '', `${p.name}.${field} must have en`)
        }
      }

      // Every plugin in our curated set should have category & labels referencing declared ids
      assert.ok(p.metadata?.category, `${p.name} should declare a category`)
      assert.ok(Object.hasOwn(parsed.metadata.categories, p.metadata.category))
      for (const label of p.metadata?.labels ?? []) {
        assert.ok(Object.hasOwn(parsed.metadata.labels, label))
      }

      // Versions non-empty, exact SemVer, strictly descending order, valid source & engines.dsh
      assert.ok(p.versions.length > 0, `${p.name} must have at least one version`)
      for (let j = 0; j < p.versions.length; j++) {
        const v = p.versions[j]
        assert.ok(isExactSemver(v.version), `${p.name} version ${v.version} must be exact SemVer`)
        if (j > 0) {
          assert.ok(
            rcompareSemver(p.versions[j - 1].version, v.version) < 0,
            `${p.name} versions must be in descending SemVer order (${p.versions[j - 1].version} vs ${v.version})`,
          )
        }
        assert.ok(
          Number.isInteger(v.publishTimestamp) && v.publishTimestamp > 0 && v.publishTimestamp < 1e11,
          `${p.name}@${v.version} publishTimestamp must be Unix seconds`,
        )
        assert.ok(v.source.type === 'npm' || v.source.type === 'git')
        if (v.engines?.dsh !== undefined) {
          assert.ok(!v.engines.dsh.startsWith('workspace:'))
          assert.ok(isValidRange(v.engines.dsh), `${p.name}@${v.version} engines.dsh invalid: ${v.engines.dsh}`)
        }
      }

      // Latest version should be compatible with DSH 0.2.2-rc.4
      const latest = vp.versions[0]
      if (latest.engines.dsh) {
        assert.ok(
          satisfiesRange('0.2.2-rc.4', latest.engines.dsh),
          `${p.name}@${latest.version} (${latest.engines.dsh}) must be compatible with DSH 0.2.2-rc.4`,
        )
      }

      // Install target builds cleanly
      const target = marketInstallTarget(vp.name, latest)
      assert.equal(target.spec, `${vp.name}@${latest.version}`)
    }
  })

  it('satisfies inline icon <= 32 KiB rule and ensures every external icon file exists in site/icons/', () => {
    const raw = JSON.parse(readFileSync(INDEX_PATH, 'utf8'))
    for (const p of raw.plugins) {
      if (!p.icon) continue
      if (p.icon.startsWith('data:')) {
        const b64 = p.icon.slice(p.icon.indexOf(',') + 1)
        const decodedBytes = Buffer.from(b64, 'base64').length
        assert.ok(
          decodedBytes <= MAX_INLINE_ICON_BYTES,
          `${p.name} inline icon is ${decodedBytes} bytes (> ${MAX_INLINE_ICON_BYTES})`,
        )
      } else {
        assert.ok(p.icon.startsWith('icons/'), `${p.name} relative icon should live under icons/`)
        const abs = resolve(SITE_DIR, p.icon)
        assert.ok(existsSync(abs), `${p.name} icon file missing: ${abs}`)
        assert.ok(statSync(abs).size > 0, `${p.name} icon file must be non-empty`)
      }
    }
  })

  it('generates static catalog site/index.html containing all plugin names', () => {
    assert.ok(existsSync(HTML_PATH), 'site/index.html must exist')
    const html = readFileSync(HTML_PATH, 'utf8')
    const raw = JSON.parse(readFileSync(INDEX_PATH, 'utf8'))
    assert.ok(html.includes('id="market-data"'))
    for (const p of raw.plugins) {
      assert.ok(html.includes(p.name), `site/index.html should include ${p.name}`)
    }
  })
})

describe('Format 1 validator negative checks & SemVer rules', () => {
  it('rejects localized objects missing `en`, undeclared categories/labels, invalid SemVer, and oversized inline icons', () => {
    assert.throws(
      () => parseMarketIndex({ format: 1, title: { zh: '无英文' }, plugins: [] }, 'https://x.test/index.json'),
      (err) => err instanceof MarketIndexError && err.path === '$.title',
    )
    assert.throws(
      () =>
        parseMarketIndex(
          {
            format: 1,
            title: 'Test',
            plugins: [
              {
                name: 'demo-plugin',
                metadata: { category: 'missing-cat' },
                versions: [{ version: '1.0.0', publishTimestamp: 1000, source: { type: 'npm' } }],
              },
            ],
          },
          'https://x.test/index.json',
        ),
      (err) => err instanceof MarketIndexError && err.path === '$.plugins[0].metadata.category',
    )
    assert.throws(
      () =>
        parseMarketIndex(
          {
            format: 1,
            title: 'Test',
            plugins: [
              {
                name: 'demo-plugin',
                icon: `data:image/png;base64,${Buffer.alloc(MAX_INLINE_ICON_BYTES + 1).toString('base64')}`,
                versions: [{ version: '1.0.0', publishTimestamp: 1000, source: { type: 'npm' } }],
              },
            ],
          },
          'https://x.test/index.json',
        ),
      (err) => err instanceof MarketIndexError && err.path === '$.plugins[0].icon',
    )
  })

  it('derives DSH ranges accurately from engines.dsh and peerDependencies', () => {
    assert.equal(deriveDshRange({ engines: { dsh: '^0.2.0-rc.1' } }), '^0.2.0-rc.1')
    assert.equal(deriveDshRange({ peerDependencies: { '@deepseek-ai/dsh': 'workspace:*' } }), undefined)
    assert.equal(deriveDshRange({ peerDependencies: { '@deepseek-ai/dsh-tools': '>=0.2.0-rc.1 <0.3.0-0' } }), '>=0.2.0-rc.1 <0.3.0-0')
    assert.ok(deriveDshRange({ engines: { dsh: 'workspace:*' } }) instanceof Error)
    assert.ok(deriveDshRange({ engines: { dsh: '>=2.0.0 <1.0.0' } }) instanceof Error)
  })
})

describe('Local preview server (scripts/serve.mjs)', () => {
  it('serves /index.json and / with HTTP 200, zero redirects, and proper headers', async () => {
    const server = createStaticServer({ dir: SITE_DIR })
    await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
    try {
      const { port } = server.address()
      const base = `http://127.0.0.1:${port}`

      const jsonRes = await fetch(`${base}/index.json`, { redirect: 'manual' })
      assert.equal(jsonRes.status, 200, '/index.json must return HTTP 200 with zero redirects')
      assert.ok(jsonRes.headers.get('content-type')?.includes('application/json'))
      assert.equal(jsonRes.headers.get('access-control-allow-origin'), '*')
      const parsed = parseMarketIndex(await jsonRes.json(), `${base}/index.json`)
      assert.ok(parsed.plugins.length >= 5)

      // Verify any relative icons resolve directly with HTTP 200 and zero redirects
      for (const p of parsed.plugins) {
        if (p.icon && p.icon.startsWith(base)) {
          const iconRes = await fetch(p.icon, { redirect: 'manual' })
          assert.equal(iconRes.status, 200, `${p.icon} must return HTTP 200 with zero redirects`)
        }
      }

      const htmlRes = await fetch(`${base}/`, { redirect: 'manual' })
      assert.equal(htmlRes.status, 200, '/ must return HTTP 200 with zero redirects')
      assert.ok(htmlRes.headers.get('content-type')?.includes('text/html'))
    } finally {
      await new Promise((resolveClose) => server.close(resolveClose))
    }
  })
})

describe('Aliyun OSS publisher (scripts/publish-oss.mjs)', () => {
  it('plans icons before index.html and index.json last, and computes deterministic OSS V1 signatures', () => {
    const plan = planSiteUploads(SITE_DIR, 'plugin-market')
    assert.ok(plan.length >= 2, 'expected at least index.html and index.json')
    assert.equal(plan.at(-1).objectKey, 'plugin-market/index.json')
    assert.equal(plan.at(-1).contentType, 'application/json; charset=utf-8')
    const iconItems = plan.filter((i) => i.relPath.startsWith('icons/'))
    for (const icon of iconItems) {
      assert.equal(icon.immutable, true)
      assert.ok(plan.indexOf(icon) < plan.length - 1, 'icons must upload before index.json')
    }
    assert.equal(encodeOssKey('/plugin-market/icons/a b.png'), 'plugin-market/icons/a%20b.png')
    const auth = signOssRequest({
      method: 'PUT',
      bucket: 'mindeck-desktop-releases',
      objectKey: 'plugin-market/index.json',
      contentType: 'application/json; charset=utf-8',
      date: 'Fri, 20 Nov 2026 08:00:00 GMT',
      headers: { 'x-oss-meta-sha256': 'abc' },
      accessKeyId: 'TEST_KEY',
      accessKeySecret: 'TEST_SECRET',
    })
    assert.match(auth, /^OSS TEST_KEY:[A-Za-z0-9+/=]+$/u)
  })

  it('supports --dry-run without credentials and verifies upload order + zero-redirect public verification', async () => {
    const dryLogs = []
    const dry = await publishPluginIndexToOss({
      siteDir: SITE_DIR,
      dryRun: true,
      log: (line) => dryLogs.push(line),
    })
    assert.equal(dry.dryRun, true)
    assert.equal(
      dry.indexUrl,
      'https://mindeck-desktop-releases.oss-cn-hangzhou.aliyuncs.com/plugin-market/index.json',
    )
    assert.equal(dry.plannedKeys.at(-1), 'plugin-market/index.json')

    // Simulated end-to-end OSS publish + anonymous public verification
    const store = new Map()
    const putOrder = []
    const mockFetch = async (url, init = {}) => {
      const method = (init.method ?? 'GET').toUpperCase()
      const key = new URL(url).pathname.replace(/^\/+/u, '')
      if (method === 'PUT') {
        putOrder.push(key)
        store.set(key, {
          bytes: Buffer.from(init.body),
          contentType: init.headers['Content-Type'] ?? '',
          sha256: init.headers['x-oss-meta-sha256'] ?? '',
        })
        return new Response(null, { status: 200 })
      }
      if (method === 'HEAD') {
        const entry = store.get(key)
        if (!entry) return new Response(null, { status: 404 })
        return new Response(null, {
          status: 200,
          headers: {
            'content-length': String(entry.bytes.length),
            'content-type': entry.contentType,
            'x-oss-meta-sha256': entry.sha256,
          },
        })
      }
      if (method === 'GET') {
        const entry = store.get(key)
        if (!entry) return new Response('not found', { status: 404 })
        return new Response(entry.bytes, {
          status: 200,
          headers: { 'content-type': entry.contentType },
        })
      }
      return new Response(null, { status: 405 })
    }

    const res = await publishPluginIndexToOss({
      siteDir: SITE_DIR,
      accessKeyId: 'TEST_KEY',
      accessKeySecret: 'TEST_SECRET',
      fetchImpl: mockFetch,
      log: () => {},
    })
    assert.equal(res.dryRun, false)
    assert.equal(putOrder.at(-1), 'plugin-market/index.json', 'index.json must be PUT last')
    assert.ok(putOrder.length >= 2)

    // Second publish should skip unchanged immutable icons
    const res2 = await publishPluginIndexToOss({
      siteDir: SITE_DIR,
      accessKeyId: 'TEST_KEY',
      accessKeySecret: 'TEST_SECRET',
      fetchImpl: mockFetch,
      log: () => {},
    })
    assert.ok(res2.skippedKeys.some((k) => k.startsWith('plugin-market/icons/')))
  })
})
