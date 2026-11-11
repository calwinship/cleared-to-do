// Minimal local server with Vercel-style (req, res) shims, wired to the isolated cleared_v2 database.
// Run: node --env-file=.env scripts/dev-server.mjs   (PORT defaults to 3100)
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const base = new URL(process.env.NEON_POSTGRES_CONNECTION_STRING);
base.pathname = '/cleared_v2';
process.env.DATABASE_URL = base.toString();
// Optional: OPENROUTER_FIXTURE=1 answers clearance from a canned response (saves free-model quota).

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    res.status = (c) => ((res.statusCode = c), res);
    res.json = (o) => (res.setHeader('Content-Type', 'application/json'), res.end(JSON.stringify(o)), res);
    res.send = (b) => (res.end(b), res);
    try {
      if (url.pathname.startsWith('/api/')) {
        const name = url.pathname.slice(5).replace(/[^a-z-]/g, '');
        const mod = await import(pathToFileURL(join(root, 'api', `${name}.js`)).href);
        req.query = Object.fromEntries(url.searchParams);
        let raw = '';
        for await (const chunk of req) raw += chunk;
        try { req.body = raw ? JSON.parse(raw) : {}; } catch { req.body = {}; }
        return await mod.default(req, res);
      }
      const rel = normalize(url.pathname === '/' ? '/index.html' : url.pathname).replace(/^(\.\.[/\\])+/, '');
      const file = join(root, rel);
      if (!file.startsWith(root) || /\/(\.env|\.projects|scripts|lib|api)\b/.test(rel)) return res.status(404).send('not found');
      const body = await readFile(file);
      res.setHeader('Content-Type', TYPES[extname(file)] || 'application/octet-stream');
      res.end(body);
    } catch (err) {
      if (err.code === 'ENOENT' || err.code === 'ERR_MODULE_NOT_FOUND') return res.status(404).send('not found');
      console.error(err);
      res.status(500).send('error');
    }
  })
  .listen(process.env.PORT || 3100, () => console.log(`dev server on http://localhost:${process.env.PORT || 3100} (db cleared_v2)`));
