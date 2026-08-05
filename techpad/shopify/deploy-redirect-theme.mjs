/**
 * Sube (y opcionalmente publica) el tema puente que manda mexpads.myshopify.com
 * a mexpads.com.
 *
 *   node techpad/shopify/deploy-redirect-theme.mjs            # sube sin publicar
 *   node techpad/shopify/deploy-redirect-theme.mjs --publish  # sube y lo deja activo
 *
 * Necesita SHOPIFY_ADMIN_TOKEN (o SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET)
 * con permiso write_themes.
 *
 * Sin --publish no se toca la tienda visible: el tema queda como borrador para
 * revisarlo con la vista previa antes de activarlo.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { adminToken, shopDomain } from '../../api/_lib/shopify.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const THEME_DIR = path.join(__dirname, 'redirect-theme');
const API_VERSION = process.env.SHOPIFY_API_VERSION || '2025-01';
const THEME_NAME = 'MexPads — puente a mexpads.com';
const publish = process.argv.includes('--publish');

async function rest(token, method, endpoint, body) {
  const res = await fetch(`https://${shopDomain()}/admin/api/${API_VERSION}/${endpoint}`, {
    method,
    headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* respuesta vacía */ }
  if (!res.ok) {
    throw new Error(`${method} ${endpoint} → ${res.status} ${text.slice(0, 300)}`);
  }
  return json;
}

function themeFiles(dir, prefix = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const key = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...themeFiles(full, key));
    else out.push({ key, value: fs.readFileSync(full, 'utf8') });
  }
  return out;
}

const token = await adminToken();
console.log('Tienda:', shopDomain());

const existing = await rest(token, 'GET', 'themes.json');
const already = (existing.themes || []).find((t) => t.name === THEME_NAME);

let themeId;
if (already) {
  themeId = already.id;
  console.log(`Tema existente #${themeId} (rol: ${already.role}) — se actualizan los archivos.`);
} else {
  const created = await rest(token, 'POST', 'themes.json', {
    theme: { name: THEME_NAME, role: 'unpublished' },
  });
  themeId = created.theme.id;
  console.log(`Tema creado #${themeId}.`);
}

for (const file of themeFiles(THEME_DIR)) {
  await rest(token, 'PUT', `themes/${themeId}/assets.json`, { asset: file });
  console.log('  ✓', file.key);
  // El Asset API va a 2 llamadas/segundo; sin pausa devuelve 429.
  await new Promise((r) => setTimeout(r, 550));
}

if (publish) {
  await rest(token, 'PUT', `themes/${themeId}.json`, { theme: { role: 'main' } });
  console.log('\nTema PUBLICADO. mexpads.myshopify.com ya reenvía a mexpads.com.');
} else {
  console.log(`\nSubido sin publicar. Revísalo con la vista previa y, si te late:`);
  console.log('  node techpad/shopify/deploy-redirect-theme.mjs --publish');
}
