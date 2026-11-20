#!/usr/bin/env node
/**
 * Minimal zero-redirect static HTTP server for local DSH Discover testing.
 * Serves `site/` directly at `http://127.0.0.1:4173/index.json` and `/` with
 * HTTP 200, proper Content-Type, CORS headers, and zero HTTP redirects.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { extname, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const MIME_TYPES = {
  '.json': 'application/json; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
}

export function createStaticServer({ dir = resolve('site') } = {}) {
  const root = resolve(dir)

  return createHttpServer((req, res) => {
    const commonHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, If-None-Match, If-Modified-Since',
      'X-Content-Type-Options': 'nosniff',
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204, commonHeaders)
      res.end()
      return
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { ...commonHeaders, 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('Method Not Allowed')
      return
    }

    let pathname
    try {
      pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname)
    } catch {
      res.writeHead(400, { ...commonHeaders, 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('Bad Request')
      return
    }

    // Serve `/` directly as `index.html` with HTTP 200 (never redirect!)
    const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/u, '')
    const candidate = resolve(root, normalize(rel))
    if (candidate !== root && !candidate.startsWith(root + sep)) {
      res.writeHead(403, { ...commonHeaders, 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('Forbidden')
      return
    }

    if (!existsSync(candidate) || !statSync(candidate).isFile()) {
      res.writeHead(404, { ...commonHeaders, 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('Not Found')
      return
    }

    const ext = extname(candidate).toLowerCase()
    const contentType = MIME_TYPES[ext] ?? 'application/octet-stream'
    const body = readFileSync(candidate)
    res.writeHead(200, {
      ...commonHeaders,
      'Content-Type': contentType,
      'Content-Length': String(body.length),
      'Cache-Control': ext === '.json' ? 'no-cache' : 'public, max-age=300',
    })
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    res.end(body)
  })
}

function parseServeArgs(argv) {
  const opts = {
    host: process.env.HOST ?? '127.0.0.1',
    port: Number(process.env.PORT ?? 4173),
    dir: resolve('site'),
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--port' && argv[i + 1]) opts.port = Number(argv[++i])
    else if (arg === '--host' && argv[i + 1]) opts.host = argv[++i]
    else if (arg === '--dir' && argv[i + 1]) opts.dir = resolve(argv[++i])
    else if (arg === '-h' || arg === '--help') {
      console.log('Usage: node scripts/serve.mjs [--host 127.0.0.1] [--port 4173] [--dir site]')
      process.exit(0)
    }
  }
  return opts
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const { host, port, dir } = parseServeArgs(process.argv.slice(2))
  if (!existsSync(resolve(dir, 'index.json'))) {
    console.error(`warning: ${resolve(dir, 'index.json')} does not exist yet — run "npm run build" first.`)
  }
  const server = createStaticServer({ dir })
  server.listen(port, host, () => {
    const addr = server.address()
    const actualPort = typeof addr === 'object' && addr ? addr.port : port
    console.log(`Serving ${dir}`)
    console.log(`  Catalog UI : http://${host}:${actualPort}/`)
    console.log(`  DSH Index  : http://${host}:${actualPort}/index.json`)
    console.log('Press Ctrl+C to stop.')
  })
  const shutdown = () => {
    server.close(() => process.exit(0))
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}
