/**
 * Pure Node.js SemVer 2.0.0 comparison and npm range parser/validator.
 * Zero external dependencies; matches npm `semver` semantics for exact version
 * precedence, `validRange`, and conjunction of DSH peer version ranges.
 */

const NUMERIC = '(?:0|[1-9]\\d*)'
const PRERELEASE_PART = `(?:${NUMERIC}|\\d*[a-zA-Z-][0-9a-zA-Z-]*)`
const BUILD_PART = '[0-9a-zA-Z-]+'

/** Exact SemVer 2.0.0 grammar (no leading `v`, no whitespace). */
export const EXACT_SEMVER_RE = new RegExp(
  `^${NUMERIC}\\.${NUMERIC}\\.${NUMERIC}(?:-${PRERELEASE_PART}(?:\\.${PRERELEASE_PART})*)?(?:\\+${BUILD_PART}(?:\\.${BUILD_PART})*)?$`,
  'u',
)

const PARSE_EXACT_RE = new RegExp(
  `^(${NUMERIC})\\.(${NUMERIC})\\.(${NUMERIC})(?:-(${PRERELEASE_PART}(?:\\.${PRERELEASE_PART})*))?(?:\\+(${BUILD_PART}(?:\\.${BUILD_PART})*))?$`,
  'u',
)

const NUMERIC_ONLY_RE = /^(?:0|[1-9]\d*)$/u

export function isExactSemver(value) {
  return typeof value === 'string' && EXACT_SEMVER_RE.test(value)
}

export function parseSemver(version) {
  if (typeof version !== 'string') return null
  const match = PARSE_EXACT_RE.exec(version)
  if (!match) return null
  const major = Number(match[1])
  const minor = Number(match[2])
  const patch = Number(match[3])
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || !Number.isSafeInteger(patch)) return null
  const prerelease = match[4]
    ? match[4].split('.').map((part) => (NUMERIC_ONLY_RE.test(part) ? Number(part) : part))
    : []
  return { major, minor, patch, prerelease, raw: version }
}

/** Compare two parsed SemVer objects (`-1`, `0`, `1`) per SemVer 2.0.0 section 11. */
export function compareParsed(a, b) {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1

  const aPre = a.prerelease
  const bPre = b.prerelease
  if (aPre.length === 0 && bPre.length === 0) return 0
  if (aPre.length === 0) return 1
  if (bPre.length === 0) return -1

  const len = Math.max(aPre.length, bPre.length)
  for (let i = 0; i < len; i++) {
    if (i >= aPre.length) return -1
    if (i >= bPre.length) return 1
    const ai = aPre[i]
    const bi = bPre[i]
    if (ai === bi) continue
    const aNum = typeof ai === 'number'
    const bNum = typeof bi === 'number'
    if (aNum && !bNum) return -1
    if (!aNum && bNum) return 1
    if (aNum && bNum) return ai < bi ? -1 : 1
    return ai < bi ? -1 : 1
  }
  return 0
}

export function compareSemver(a, b) {
  const pa = parseSemver(a)
  const pb = parseSemver(b)
  if (!pa || !pb) throw new TypeError(`Invalid SemVer: ${!pa ? a : b}`)
  return compareParsed(pa, pb)
}

/** Descending SemVer precedence comparator (matches `semver.rcompare`). */
export function rcompareSemver(a, b) {
  return compareSemver(b, a)
}

function formatParsed(v) {
  const base = `${v.major}.${v.minor}.${v.patch}`
  return v.prerelease.length > 0 ? `${base}-${v.prerelease.join('.')}` : base
}

function isWildcard(token) {
  return token === undefined || token === '' || token === '*' || token === 'x' || token === 'X'
}

const PARTIAL_RE = new RegExp(
  `^[v=\\s]*(${NUMERIC}|[xX*])(?:\\.(${NUMERIC}|[xX*])(?:\\.(${NUMERIC}|[xX*])(?:-(${PRERELEASE_PART}(?:\\.${PRERELEASE_PART})*))?(?:\\+${BUILD_PART}(?:\\.${BUILD_PART})*)?)?)?$`,
  'u',
)

function parsePartial(raw) {
  const m = PARTIAL_RE.exec(raw.trim())
  if (!m) return null
  const major = isWildcard(m[1]) ? null : Number(m[1])
  const minor = isWildcard(m[2]) ? null : Number(m[2])
  const patch = isWildcard(m[3]) ? null : Number(m[3])
  if (major !== null && !Number.isSafeInteger(major)) return null
  if (minor !== null && !Number.isSafeInteger(minor)) return null
  if (patch !== null && !Number.isSafeInteger(patch)) return null
  const prerelease = m[4]
    ? m[4].split('.').map((p) => (NUMERIC_ONLY_RE.test(p) ? Number(p) : p))
    : []
  return { major, minor, patch, prerelease }
}

function ver(major, minor, patch, prerelease = []) {
  return { major, minor, patch, prerelease }
}

function cmp(op, v) {
  return { op, version: v, value: `${op}${formatParsed(v)}` }
}

/** Expand a single comparator token into primitive `>=`, `<=`, `>`, `<`, or `=` comparators. */
function expandToken(token) {
  if (token === '' || token === '*' || token === 'x' || token === 'X') return []

  // Caret range `^...`
  if (token.startsWith('^')) {
    const p = parsePartial(token.slice(1))
    if (!p) return null
    if (p.major === null) return []
    const major = p.major
    const minor = p.minor ?? 0
    const patch = p.patch ?? 0
    const lower = cmp('>=', ver(major, minor, patch, p.minor !== null && p.patch !== null ? p.prerelease : []))
    let upper
    if (major > 0) {
      upper = cmp('<', ver(major + 1, 0, 0, [0]))
    } else if (p.minor === null) {
      upper = cmp('<', ver(1, 0, 0, [0]))
    } else if (minor > 0) {
      upper = cmp('<', ver(0, minor + 1, 0, [0]))
    } else if (p.patch === null) {
      upper = cmp('<', ver(0, 1, 0, [0]))
    } else {
      upper = cmp('<', ver(0, 0, patch + 1, [0]))
    }
    return [lower, upper]
  }

  // Tilde range `~...` or `~>...`
  if (token.startsWith('~')) {
    const rest = token.startsWith('~>') ? token.slice(2) : token.slice(1)
    const p = parsePartial(rest)
    if (!p) return null
    if (p.major === null) return []
    const major = p.major
    const minor = p.minor ?? 0
    const patch = p.patch ?? 0
    const lower = cmp('>=', ver(major, minor, patch, p.minor !== null && p.patch !== null ? p.prerelease : []))
    const upper = p.minor === null
      ? cmp('<', ver(major + 1, 0, 0, [0]))
      : cmp('<', ver(major, minor + 1, 0, [0]))
    return [lower, upper]
  }

  // Standard operators: >=, <=, >, <, =
  const opMatch = /^(>=|<=|>|<|=)(.+)$/u.exec(token)
  if (opMatch) {
    const op = opMatch[1]
    const p = parsePartial(opMatch[2])
    if (!p) return null
    if (p.major === null) {
      if (op === '>' || op === '<') return [cmp('<', ver(0, 0, 0, [0]))] // unsatisfiable
      return []
    }
    if (p.minor === null || p.patch === null) {
      if (op === '=') return expandToken(opMatch[2])
      if (op === '>=') return [cmp('>=', ver(p.major, p.minor ?? 0, 0, [0]))]
      if (op === '<') return [cmp('<', ver(p.major, p.minor ?? 0, 0, [0]))]
      if (op === '>') {
        return p.minor === null
          ? [cmp('>=', ver(p.major + 1, 0, 0, [0]))]
          : [cmp('>=', ver(p.major, p.minor + 1, 0, [0]))]
      }
      if (op === '<=') {
        return p.minor === null
          ? [cmp('<', ver(p.major + 1, 0, 0, [0]))]
          : [cmp('<', ver(p.major, p.minor + 1, 0, [0]))]
      }
    }
    const v = ver(p.major, p.minor, p.patch, p.prerelease)
    if (op === '=') return [cmp('>=', v), cmp('<=', v)]
    return [cmp(op, v)]
  }

  // Bare version or X-range (`1.2.3`, `1.2`, `1.2.x`, `v1.2.3`)
  const p = parsePartial(token)
  if (!p) return null
  if (p.major === null) return []
  if (p.minor === null) {
    return [cmp('>=', ver(p.major, 0, 0, [0])), cmp('<', ver(p.major + 1, 0, 0, [0]))]
  }
  if (p.patch === null) {
    return [cmp('>=', ver(p.major, p.minor, 0, [0])), cmp('<', ver(p.major, p.minor + 1, 0, [0]))]
  }
  const v = ver(p.major, p.minor, p.patch, p.prerelease)
  return [cmp('>=', v), cmp('<=', v)]
}

/** Expand a hyphen range `from - to`. */
function expandHyphen(fromRaw, toRaw) {
  const from = parsePartial(fromRaw)
  const to = parsePartial(toRaw)
  if (!from || !to) return null
  const out = []
  if (from.major !== null) {
    const hasAll = from.minor !== null && from.patch !== null
    out.push(cmp('>=', ver(from.major, from.minor ?? 0, from.patch ?? 0, hasAll ? from.prerelease : [0])))
  }
  if (to.major !== null) {
    if (to.minor === null) {
      out.push(cmp('<', ver(to.major + 1, 0, 0, [0])))
    } else if (to.patch === null) {
      out.push(cmp('<', ver(to.major, to.minor + 1, 0, [0])))
    } else {
      out.push(cmp('<=', ver(to.major, to.minor, to.patch, to.prerelease)))
    }
  }
  return out
}

/**
 * Parse an npm SemVer range string into an array of `||` alternatives, where each
 * alternative is an array of primitive comparators (`>=`, `<=`, `>`, `<`).
 * Returns `null` if the range is syntactically invalid.
 */
export function parseRange(range) {
  if (typeof range !== 'string') return null
  const trimmed = range.trim()
  if (trimmed === '') return [[]]

  const parts = trimmed.split('||')
  const alternatives = []
  for (const part of parts) {
    let clause = part.trim()
    if (clause === '') {
      alternatives.push([])
      continue
    }
    // Normalize spaces after operators (`>= 1.0.0` -> `>=1.0.0`, `^ 1.0.0` -> `^1.0.0`)
    clause = clause.replace(/(>=|<=|>|<|=|\^|~>|~)\s+/gu, '$1')

    // Handle hyphen range (`A - B`)
    const hyphen = /^(\S+)\s+-\s+(\S+)$/u.exec(clause)
    if (hyphen) {
      const expanded = expandHyphen(hyphen[1], hyphen[2])
      if (expanded === null) return null
      alternatives.push(expanded)
      continue
    }

    const tokens = clause.split(/\s+/u).filter(Boolean)
    const comparators = []
    for (const token of tokens) {
      const expanded = expandToken(token)
      if (expanded === null) return null
      comparators.push(...expanded)
    }
    alternatives.push(comparators)
  }
  return alternatives
}

/** Return true if `range` is a valid npm SemVer range (mirrors `semver.validRange(range) !== null`). */
export function isValidRange(range) {
  return parseRange(range) !== null
}

/** Check if a conjunction of primitive comparators can be satisfied by at least one SemVer (including prereleases). */
export function isConjunctionSatisfiable(comparators) {
  let lower = null // { version, inclusive }
  let upper = null // { version, inclusive }

  for (const c of comparators) {
    if (c.op === '>=' || c.op === '>') {
      const inclusive = c.op === '>='
      if (lower === null) {
        lower = { version: c.version, inclusive }
      } else {
        const d = compareParsed(c.version, lower.version)
        if (d > 0 || (d === 0 && !inclusive)) {
          lower = { version: c.version, inclusive }
        }
      }
    } else if (c.op === '<=' || c.op === '<') {
      const inclusive = c.op === '<='
      if (upper === null) {
        upper = { version: c.version, inclusive }
      } else {
        const d = compareParsed(c.version, upper.version)
        if (d < 0 || (d === 0 && !inclusive)) {
          upper = { version: c.version, inclusive }
        }
      }
    }
  }

  if (upper !== null) {
    // No SemVer version exists below `0.0.0-0`
    const minPossible = ver(0, 0, 0, [0])
    const dMin = compareParsed(upper.version, minPossible)
    if (dMin < 0 || (dMin === 0 && !upper.inclusive)) return false
  }

  if (lower !== null && upper !== null) {
    const d = compareParsed(lower.version, upper.version)
    if (d > 0) return false
    if (d === 0 && (!lower.inclusive || !upper.inclusive)) return false
  }
  return true
}

/** Check if a SemVer version satisfies a range (with `includePrerelease: true`). */
export function satisfiesRange(version, range) {
  const parsed = parseSemver(version)
  const alts = parseRange(range)
  if (!parsed || !alts) return false
  return alts.some((comparators) =>
    comparators.every((c) => {
      const d = compareParsed(parsed, c.version)
      if (c.op === '>=') return d >= 0
      if (c.op === '>') return d > 0
      if (c.op === '<=') return d <= 0
      if (c.op === '<') return d < 0
      return d === 0
    }),
  )
}

const MAX_RANGE_ALTERNATIVES = 256
const DSH_PEER_RE = /^@deepseek-ai\/dsh(?:-|$)/u
const CURRENT_DSH_PEERS = new Set(['workspace:*', 'workspace:^', 'workspace:~'])

/**
 * Derive `engines.dsh` from a manifest following DSH's official generator rules:
 * - Use `manifest.engines.dsh` when present;
 * - Otherwise combine `@deepseek-ai/dsh` and `@deepseek-ai/dsh-*` `peerDependencies`,
 *   ignoring `workspace:*`, `workspace:^`, `workspace:~`, and `*`.
 * Returns `string` (range), `undefined` (any version), or `Error` (invalid / unsatisfiable).
 */
export function deriveDshRange(manifest) {
  const engines = manifest?.engines
  const declared = engines && typeof engines === 'object' && !Array.isArray(engines) ? engines.dsh : undefined
  const peers = manifest?.peerDependencies
  const rawRanges = typeof declared === 'string'
    ? [declared]
    : Object.entries(peers && typeof peers === 'object' && !Array.isArray(peers) ? peers : {})
      .flatMap(([name, r]) => (DSH_PEER_RE.test(name) && typeof r === 'string' && !CURRENT_DSH_PEERS.has(r) ? [r] : []))

  const used = [...new Set(rawRanges.map((r) => r.trim()))].filter((r) => r !== '*')
  if (used.length === 0) return undefined

  let combinations = [[]]
  for (const range of used) {
    if (range === '' || range.startsWith('workspace:')) {
      return new Error(`DSH range ${JSON.stringify(range)} is not a valid SemVer range`)
    }
    const alts = parseRange(range)
    if (alts === null) {
      return new Error(`DSH range ${JSON.stringify(range)} is not a valid SemVer range`)
    }
    if (combinations.length * alts.length > MAX_RANGE_ALTERNATIVES) {
      return new Error(`DSH peer ranges combine into more than ${MAX_RANGE_ALTERNATIVES} alternatives`)
    }
    combinations = combinations
      .flatMap((prefix) => alts.map((alt) => deduplicateComparators([...prefix, ...alt])))
      .filter((comb) => isConjunctionSatisfiable(comb))
  }

  if (combinations.length === 0) {
    return new Error(`no DSH version satisfies ${used.length === 1 ? 'the DSH range' : 'every DSH peer range'}: ${used.join(', ')}`)
  }
  const written = [...new Set(combinations.map((comb) => comb.map((c) => c.value).join(' ') || '*'))]
  if (written.includes('*')) return undefined
  return used.length === 1 ? used[0] : written.join(' || ')
}

function deduplicateComparators(comparators) {
  const seen = new Set()
  const out = []
  for (const c of comparators) {
    if (seen.has(c.value)) continue
    seen.add(c.value)
    out.push(c)
  }
  return out
}
