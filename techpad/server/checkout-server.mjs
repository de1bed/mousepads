/**
 * Servidor local: sirve techpad/ y monta las MISMAS funciones que Vercel.
 *   node techpad/server/checkout-server.mjs
 *
 * Importa los handlers de /api en vez de reimplementarlos, para que lo que se
 * prueba en local sea exactamente lo que corre en producción.
 * Variables: SHOPIFY_ADMIN_TOKEN (o SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET).
 */
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { createReadStream } from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const API_DIR = path.join(ROOT, '..', 'api');
const PORT = Number(process.env.PORT || 8123);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
};

/** /api/design/stage → api/design/stage.js */
async function loadApiHandler(urlPath) {
  const rel = urlPath.replace(/^\/api\//, '');
  if (!rel || rel.includes('..') || rel.startsWith('_')) return null;
  const file = path.join(API_DIR, rel + '.js');
  if (!fs.existsSync(file)) return null;
  const mod = await import(pathToFileURL(file).href + '?t=' + Date.now());
  return mod.default || null;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** IncomingMessage → Request, para poder reusar los handlers tal cual. */
async function toWebRequest(req) {
  const host = req.headers.host || `127.0.0.1:${PORT}`;
  const url = new URL(req.url || '/', `http://${host}`);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) v.forEach((one) => headers.append(k, one));
    else if (v != null) headers.set(k, String(v));
  }
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  return new Request(url.href, {
    method: req.method,
    headers,
    body: hasBody ? await readBody(req) : undefined,
  });
}

async function sendWebResponse(res, webRes) {
  const headers = {};
  webRes.headers.forEach((v, k) => { headers[k] = v; });
  res.writeHead(webRes.status, headers);
  const buf = Buffer.from(await webRes.arrayBuffer());
  res.end(buf);
}

const server = http.createServer(async (req, res) => {
  const reqUrl = req.url || '/';
  let urlPath = decodeURIComponent(reqUrl.split('?')[0]);

  if (urlPath.startsWith('/api/')) {
    try {
      const handler = await loadApiHandler(urlPath);
      if (!handler) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: 'Ruta no encontrada: ' + urlPath }));
      }
      const webRes = await handler(await toWebRequest(req));
      return sendWebResponse(res, webRes);
    } catch (err) {
      console.error('[api] %s → %s', urlPath, err.stack || err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: String(err.message || err) }));
    }
  }

  if (urlPath === '/') urlPath = '/index.html';
  // Some clients strip a trailing ".html" from "*.dc.html" → "*.dc"
  if (/\.dc$/i.test(urlPath)) urlPath += '.html';

  const rootResolved = path.resolve(ROOT);
  const filePath = path.resolve(rootResolved, '.' + urlPath.replace(/\\/g, '/'));
  if (!filePath.toLowerCase().startsWith(rootResolved.toLowerCase() + path.sep) &&
      filePath.toLowerCase() !== rootResolved.toLowerCase()) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    return res.end('Forbidden');
  }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Not found: ' + urlPath);
  }
  const ext = path.extname(filePath).toLowerCase();
  const type = MIME[ext] || (filePath.toLowerCase().endsWith('.dc.html') ? 'text/html; charset=utf-8' : 'application/octet-stream');
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
  createReadStream(filePath).pipe(res);
});

server.listen(PORT, () => {
  console.log(`MexPads → http://127.0.0.1:${PORT}`);
  console.log('API local: /api/health, /api/design/stage, /api/design/finalize, /api/print/build');
  if (!process.env.SHOPIFY_ADMIN_TOKEN && !process.env.SHOPIFY_CLIENT_ID) {
    console.warn('⚠ Sin credenciales de Shopify: las rutas de diseño responderán 502.');
  }
});
