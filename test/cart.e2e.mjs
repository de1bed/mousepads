/**
 * Prueba de navegador del flujo que estaba roto: subir un diseño, agregarlo y
 * verlo en el carrito — y que siga ahí después de recargar.
 *
 * Playwright no está en package.json a propósito (Vercel no debe instalarlo):
 *   npm i --no-save playwright && npx playwright install chromium
 *   node test/cart.e2e.mjs
 *
 * Las llamadas a Shopify van simuladas: aquí se prueba el front, no la red.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = 'http://127.0.0.1:8199';

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
}

const server = spawn('node', ['techpad/server/checkout-server.mjs'], {
  cwd: ROOT,
  env: { ...process.env, PORT: '8199' },
  stdio: 'ignore',
});
await new Promise((r) => setTimeout(r, 1500));

// Si el entorno trae un Chromium preinstalado con otra numeración que la que
// espera esta versión de Playwright, se apunta a él con CHROMIUM_PATH.
const browser = await chromium.launch(
  process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}
);
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

// React viene de unpkg; si la red del entorno lo bloquea, se sirve local.
const localReact = path.join(ROOT, 'node_modules/react/umd/react.production.min.js');
if (fs.existsSync(localReact)) {
  const REACT = fs.readFileSync(localReact);
  const REACT_DOM = fs.readFileSync(path.join(ROOT, 'node_modules/react-dom/umd/react-dom.production.min.js'));
  await page.route('**/unpkg.com/**', (route) => route.fulfill({
    status: 200,
    contentType: 'application/javascript',
    body: /react-dom/.test(route.request().url()) ? REACT_DOM : REACT,
  }));
}

let finalizeCount = 0;
const apiCalls = [];
await page.route('**/api/design/stage', (route) => {
  apiCalls.push('stage');
  route.fulfill({ json: {
    ok: true, filename: 'test.png',
    url: 'https://staged.test/upload', resourceUrl: 'https://staged.test/r/1', parameters: [],
  } });
});
await page.route('https://staged.test/**', (route) => {
  apiCalls.push('direct-upload');
  route.fulfill({ status: 204, body: '' });
});
await page.route('**/api/design/finalize', (route) => {
  apiCalls.push('finalize');
  finalizeCount += 1;
  route.fulfill({ json: {
    ok: true,
    designId: 'gid://shopify/MediaImage/' + finalizeCount,
    originalUrl: 'https://cdn.test/' + finalizeCount + '.png',
    // 3000 px de ancho en un XL = 83 DPI → debe avisar
    width: 3000, height: 1500,
  } });
});

const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.evaluate(() => {
  const el = [...document.querySelectorAll('a,button')].find((n) => /personaliza/i.test(n.textContent || ''));
  if (el) el.click();
});
await page.waitForTimeout(1200);

// Un PNG mínimo válido basta: lo que importa es el flujo, no el contenido.
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);
await page.locator('input[type=file]').first()
  .setInputFiles({ name: 'mi-diseno.png', mimeType: 'image/png', buffer: png });
await page.waitForTimeout(2500);

check('el diseño se sube al elegirlo', apiCalls.join(',') === 'stage,direct-upload,finalize', apiCalls.join(','));
check('avisa la resolución baja antes de pagar', (await page.locator('text=/DPI en este encuadre/i').count()) > 0);

await page.evaluate(() => {
  const el = [...document.querySelectorAll('button')].find((n) => /personalizar y agregar/i.test(n.textContent || ''));
  if (el) el.click();
});
await page.waitForTimeout(2000);

const drawer = page.locator('[role=dialog]');
const drawerText = await drawer.first().innerText().catch(() => '');
check('el carrito se abre con el diseño dentro', /MOUSEPAD PERSONALIZADO/i.test(drawerText));

const imgSrc = await drawer.locator('img').first().getAttribute('src').catch(() => null);
check('la miniatura es duradera, no un blob:', !!imgSrc && imgSrc.startsWith('data:image/'), (imgSrc || '').slice(0, 24));
check('el carrito marca la resolución baja', /Resoluci/i.test(drawerText));

const stored = await page.evaluate(() => JSON.parse(window.localStorage.getItem('mexpads.cart') || '[]'));
check('la línea lleva los datos de impresión', !!(stored[0] && stored[0].designId && stored[0].posX != null && stored[0].zoom != null));

await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
const after = await page.evaluate(() => JSON.parse(window.localStorage.getItem('mexpads.cart') || '[]'));
check('el carrito sobrevive a recargar', after.length === 1 && String(after[0].thumb || '').startsWith('data:'));

// Segundo diseño distinto: tiene que ser OTRO renglón, no sumar cantidad.
await page.evaluate(() => {
  const el = [...document.querySelectorAll('a,button')].find((n) => /personaliza/i.test(n.textContent || ''));
  if (el) el.click();
});
await page.waitForTimeout(1200);
await page.locator('input[type=file]').first()
  .setInputFiles({ name: 'otro.png', mimeType: 'image/png', buffer: png });
await page.waitForTimeout(2500);
await page.evaluate(() => {
  const el = [...document.querySelectorAll('button')].find((n) => /personalizar y agregar/i.test(n.textContent || ''));
  if (el) el.click();
});
await page.waitForTimeout(1500);
const two = await page.evaluate(() => JSON.parse(window.localStorage.getItem('mexpads.cart') || '[]'));
check('dos diseños distintos son dos renglones', two.length === 2, two.map((c) => c.designId).join(' / '));

check('sin errores de JavaScript', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));

await browser.close();
server.kill();

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} pruebas pasaron`);
process.exit(failed.length ? 1 : 0);
