#!/usr/bin/env node
/**
 * Standalone DSH Format-1 Index Validator CLI.
 * Validates `site/index.json` (or a given path) against every Format 1 rule,
 * verifies relative icon files exist on disk and meet size bounds, and prints
 * a summary of validated plugins and exact install targets.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { marketInstallTarget, MAX_INLINE_ICON_BYTES, parseMarketIndex } from './lib/format1.mjs'

const MAX_EXTERNAL_ICON_BYTES = 256 * 1024

export function validateIndexFile(indexPath, baseUrl = 'https://example.invalid/index.json') {
  const absPath = resolve(indexPath)
  if (!existsSync(absPath)) {
    throw new Error(`index file not found: ${absPath}`)
  }
  const raw = JSON.parse(readFileSync(absPath, 'utf8'))
  const parsed = parseMarketIndex(raw, baseUrl)

  // Verify any relative icon references exist on disk inside the output directory
  const outDir = dirname(absPath)
  for (let i = 0; i < raw.plugins.length; i++) {
    const plugin = raw.plugins[i]
    if (!plugin.icon) continue
    if (plugin.icon.startsWith('data:')) continue
    if (/^https?:\/\//iu.test(plugin.icon)) continue
    const iconFile = resolve(outDir, plugin.icon)
    if (!existsSync(iconFile)) {
      throw new Error(`$.plugins[${i}].icon references missing local file: ${plugin.icon}`)
    }
    const size = statSync(iconFile).size
    if (size === 0 || size > MAX_EXTERNAL_ICON_BYTES) {
      throw new Error(`$.plugins[${i}].icon file size (${size} bytes) out of bounds (1..${MAX_EXTERNAL_ICON_BYTES})`)
    }
  }

  return { raw, parsed }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const target = process.argv[2] ?? 'site/index.json'
  const baseUrl = process.argv[3] ?? 'https://example.invalid/index.json'
  try {
    const { parsed } = validateIndexFile(target, baseUrl)
    console.log(
      `OK: ${resolve(target)} is a valid DSH Format 1 index (${parsed.plugins.length} plugins, inline icon limit ${MAX_INLINE_ICON_BYTES / 1024} KiB).`,
    )
    for (const p of parsed.plugins) {
      const latest = p.versions[0]
      const install = marketInstallTarget(p.name, latest)
      const dsh = latest.engines.dsh ? ` [dsh: ${latest.engines.dsh}]` : ''
      const cat = p.metadata.category ? ` (${p.metadata.category})` : ''
      console.log(`  - ${install.spec}${cat}${dsh} — ${p.versions.length} versions`)
    }
  } catch (err) {
    console.error(`VALIDATION FAILED: ${err.message}`)
    process.exitCode = 1
  }
}
