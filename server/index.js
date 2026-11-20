// Serveur SIPA : API REST, PWA statique et flux temps réel (SSE).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { getDb, audit } from './db.js';
import { verifyJwt } from './crypto.js';
import { matchRoute, ApiError, listRoutes } from './api.js';
import { seedDemo } from './demo.js';

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? '127.0.0.1';
const PUBLIC_DIR = path.join(process.cwd(), 'public');
const MAX_BODY = 512 * 1024;

// ------------------------------------------------------------------ Événements
const streams = new Map(); // channel -> Set<res>

globalThis.__sipaEvents = {
  emit(channel, payload) {
    const clients = streams.get(channel);
    if (!clients) return;
    const frame = `data: ${JSON.stringify(payload)}\n\n`;
    for (const res of clients) {
      try {
        res.write(frame);
      } catch {
        clients.delete(res);
      }
    }
  },
};

function subscribe(channel, res) {
  if (!streams.has(channel)) streams.set(channel, new Set());
  streams.get(channel).add(res);
  const heartbeat = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      clearInterval(heartbeat);
    }
  }, 25_000);
  res.on('close', () => {
    clearInterval(heartbeat);
    streams.get(channel)?.delete(res);
  });
}

// ---------------------------------------------------------------------- Utils
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'geolocation=(self), camera=(self), microphone=()',
  'Content-Security-Policy': [
    "default-src 'self'",
    "img-src 'self' data: blob: https://*.tile.openstreetmap.org",
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self'",
    "connect-src 'self' https://*.tile.openstreetmap.org",
    "font-src 'self' data:",
    "media-src 'self' blob:",
    "worker-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; '),
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new ApiError(413, 'Requête trop volumineuse.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new ApiError(400, 'Corps JSON invalide.'));
      }
    });
    req.on('error', reject);
  });
}

function staffById(id) {
  return getDb().prepare('SELECT * FROM staff WHERE id = ?').get(id) ?? null;
}

async function handleApi(req, res, url, params, route) {
  const ctx = {
    req,
    res,
    url,
    query: url.searchParams,
    params: params ?? {},
    body: {},
    user: null,
    staff: null,
  };

  if (req.method === 'POST' || req.method === 'PATCH' || req.method === 'PUT') {
    ctx.body = await readBody(req);
  }

  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const payload = token ? verifyJwt(token) : null;
  if (payload?.typ === 'user') {
    ctx.user = getDb().prepare('SELECT * FROM users WHERE id = ?').get(payload.sub) ?? null;
  } else if (payload?.typ === 'staff') {
    ctx.staff = staffById(payload.sub);
  }

  const result = await route.handler(ctx);

  if (result && typeof result === 'object' && '__csv' in result) {
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${result.filename}"`,
      'Cache-Control': 'no-store',
    });
    return res.end(`\uFEFF${result.__csv}`);
  }
  if (result && typeof result === 'object' && '__text' in result) {
    res.writeHead(result.status ?? 200, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end(String(result.__text));
  }
  return sendJson(res, 200, result ?? { ok: true });
}

// --------------------------------------------------------------------- Statique
function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';
  let filePath = path.join(PUBLIC_DIR, pathname);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403, SECURITY_HEADERS);
    return res.end('Forbidden');
  }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    if (url.pathname.startsWith('/api')) {
      res.writeHead(404, { ...SECURITY_HEADERS, 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Route inconnue.' }));
    }
    filePath = path.join(PUBLIC_DIR, 'index.html');
  }
  const ext = path.extname(filePath).toLowerCase();
  const isShell = ['/index.html', '/sw.js'].includes(pathname) || ['.js', '.css', '.webmanifest'].includes(ext);
  const stat = fs.statSync(filePath);
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'Content-Type': MIME[ext] ?? 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': isShell ? 'no-cache' : ext === '.html' ? 'no-cache' : 'public, max-age=300',
  });
  fs.createReadStream(filePath).pipe(res);
}

// ------------------------------------------------------------------------ Boot
getDb();
seedDemo();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? `localhost:${PORT}`}`);
  const pathname = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      ...SECURITY_HEADERS,
      'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization,Content-Type,X-Vault-Unlock-Token',
    });
    return res.end();
  }

  // Flux temps réel (EventSource ne peut pas porter d'en-tête : jeton en query).
  if (pathname === '/api/v1/stream') {
    const payload = verifyJwt(url.searchParams.get('token') ?? '');
    if (!payload || payload.typ !== 'user') {
      res.writeHead(401, { ...SECURITY_HEADERS, 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Jeton de flux invalide.' }));
    }
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connecté\n\n');
    subscribe(`user:${payload.sub}`, res);
    const open = getDb()
      .prepare("SELECT id FROM chat_escalations WHERE user_id = ? AND status <> 'CLOSED' ORDER BY created_at DESC LIMIT 1")
      .get(payload.sub);
    if (open) subscribe(`escalation:${open.id}`, res);
    return;
  }

  if (pathname === '/api/v1/pro/stream') {
    const payload = verifyJwt(url.searchParams.get('token') ?? '');
    if (!payload || payload.typ !== 'staff') {
      res.writeHead(401, { ...SECURITY_HEADERS, 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Jeton de flux invalide.' }));
    }
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connecté\n\n');
    subscribe('counselors', res);
    const open = getDb().prepare("SELECT id FROM chat_escalations WHERE status <> 'CLOSED'").all();
    for (const row of open) subscribe(`escalation:${row.id}`, res);
    return;
  }

  if (pathname === '/api/v1/health') {
    const routes = listRoutes().length;
    return sendJson(res, 200, { status: 'ok', routes, uptime: Math.round(process.uptime()) });
  }

  if (pathname.startsWith('/api/')) {
    if (req.method === 'GET' && pathname === '/api/v1/meta') {
      // route publique gérée par la table
    }
    const match = matchRoute(req.method, pathname);
    if (!match) return sendJson(res, 404, { error: 'Route inconnue.' });
    try {
      await handleApi(req, res, url, match.params, match.route);
    } catch (error) {
      if (error instanceof ApiError) {
        return sendJson(res, error.status, { error: error.message, ...(error.details ?? {}) });
      }
      console.error('[SIPA][API]', error);
      return sendJson(res, 500, { error: 'Erreur interne du service.' });
    }
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, SECURITY_HEADERS);
    return res.end();
  }
  serveStatic(req, res, url);
});

server.listen(PORT, HOST, () => {
  console.log(`\n  SIPA — prototype viable`);
  console.log(`  → http://localhost:${PORT}`);
  console.log(`  → portail professionnel : http://localhost:${PORT}/#/pro`);
  console.log(`  ${listRoutes().length} routes API · SSE temps réel · PWA hors-ligne\n`);
});

process.on('SIGINT', () => {
  console.log('\n[SIPA] Arrêt du serveur.');
  server.close(() => process.exit(0));
});
