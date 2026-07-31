/**
 * Local bridge: static site + design upload to Shopify Files + checkout helper.
 *   node techpad/server/checkout-server.mjs
 * Serves techpad/ on :8123 and POST /api/shopify/upload
 */
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createReadStream } from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.PORT || 8123);
const DOMAIN = 'mexpads.myshopify.com';
const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID || '';
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET || '';
if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Missing SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET env vars');
  process.exit(1);
}

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

async function adminToken() {
  const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  const res = await fetch(`https://${DOMAIN}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  const j = await res.json();
  if (!j.access_token) throw new Error('token failed');
  return j.access_token;
}

async function adminGql(token, query, variables) {
  const res = await fetch(`https://${DOMAIN}/admin/api/2025-01/graphql.json`, {
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  return res.json();
}

async function uploadDesign(dataUrl, filename) {
  const m = String(dataUrl).match(/^data:([^;]+);base64,(.+)$/);
  if (!m) throw new Error('dataUrl inválido');
  const mime = m[1];
  const buf = Buffer.from(m[2], 'base64');
  const token = await adminToken();

  const staged = await adminGql(token, `mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
    stagedUploadsCreate(input: $input) {
      stagedTargets { url resourceUrl parameters { name value } }
      userErrors { message }
    }
  }`, {
    input: [{
      filename: filename || 'diseno.png',
      mimeType: mime,
      httpMethod: 'POST',
      resource: 'FILE',
      fileSize: String(buf.length),
    }],
  });
  const target = staged.data?.stagedUploadsCreate?.stagedTargets?.[0];
  if (!target) throw new Error('staged upload failed: ' + JSON.stringify(staged));

  const form = new FormData();
  for (const p of target.parameters) form.append(p.name, p.value);
  form.append('file', new Blob([buf], { type: mime }), filename || 'diseno.png');
  const up = await fetch(target.url, { method: 'POST', body: form });
  if (!up.ok && up.status !== 201 && up.status !== 204) {
    const t = await up.text();
    throw new Error('upload http ' + up.status + ' ' + t.slice(0, 200));
  }

  const created = await adminGql(token, `mutation fileCreate($files: [FileCreateInput!]!) {
    fileCreate(files: $files) {
      files { ... on MediaImage { id image { url } } ... on GenericFile { id url } }
      userErrors { message }
    }
  }`, {
    files: [{
      originalSource: target.resourceUrl,
      contentType: mime.startsWith('image/') ? 'IMAGE' : 'FILE',
      alt: 'Diseno cliente MexPads',
    }],
  });
  const file = created.data?.fileCreate?.files?.[0];
  const url = file?.image?.url || file?.url || target.resourceUrl;
  return { url, id: file?.id || null };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function send(res, code, body, type) {
  res.writeHead(code, {
    'Content-Type': type || 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, '');

  const reqUrl = req.url || '/';
  if (req.method === 'POST' && reqUrl.split('?')[0] === '/api/shopify/upload') {
    try {
      const raw = await readBody(req);
      const json = JSON.parse(raw.toString('utf8'));
      const out = await uploadDesign(json.dataUrl, json.filename);
      return send(res, 200, JSON.stringify(out));
    } catch (e) {
      return send(res, 500, JSON.stringify({ error: String(e.message || e) }));
    }
  }

  let urlPath = decodeURIComponent(reqUrl.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';

  // Some clients strip a trailing ".html" from "*.dc.html" → "*.dc"
  if (/\.dc$/i.test(urlPath)) urlPath += '.html';

  const rootResolved = path.resolve(ROOT);
  let filePath = path.resolve(rootResolved, '.' + urlPath.replace(/\\/g, '/'));
  if (!filePath.toLowerCase().startsWith(rootResolved.toLowerCase() + path.sep) &&
      filePath.toLowerCase() !== rootResolved.toLowerCase()) {
    return send(res, 403, 'Forbidden', 'text/plain');
  }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    return send(res, 404, 'Not found: ' + urlPath, 'text/plain');
  }
  const ext = path.extname(filePath).toLowerCase();
  const type = MIME[ext] || (filePath.toLowerCase().endsWith('.dc.html') ? 'text/html; charset=utf-8' : 'application/octet-stream');
  res.writeHead(200, {
    'Content-Type': type,
    'Cache-Control': 'no-cache',
    'Access-Control-Allow-Origin': '*',
  });
  createReadStream(filePath).pipe(res);
});

server.listen(PORT, () => {
  console.log(`MexPads store server http://127.0.0.1:${PORT}`);
  console.log('Upload bridge POST /api/shopify/upload');
});
