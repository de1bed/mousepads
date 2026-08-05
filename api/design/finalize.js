/**
 * POST /api/design/finalize
 *
 * Se llama cuando el navegador ya subió el original al destino temporal.
 * Registra el archivo en Shopify Files (original intacto, es la fuente de
 * verdad) y devuelve la ficha de impresión calculada con las dimensiones
 * reales — así el cliente ve el aviso de resolución baja ANTES de pagar.
 *
 * El render pesado no ocurre aquí: se hace una sola vez por pedido en el
 * webhook orders/create, que es donde de verdad hace falta.
 *
 * body: { resourceUrl, filename, mimeType, size, posX, posY, zoom }
 * →     { ok, designId, originalUrl, width, height, spec }
 */
import { fileCreate, waitForFile } from '../../lib/shopify.js';
import { printSpec } from '../../lib/print.js';
import { fail, isAllowedImage, json, preflight, safeFilename } from '../../lib/http.js';

export const config = { runtime: 'nodejs', maxDuration: 60 };

export default async function handler(request) {
  if (request.method === 'OPTIONS') return preflight(request);
  if (request.method !== 'POST') return fail(request, 405, 'Método no permitido');

  let body;
  try {
    body = await request.json();
  } catch {
    return fail(request, 400, 'JSON inválido');
  }

  const resourceUrl = String(body.resourceUrl || '');
  const mimeType = String(body.mimeType || '').toLowerCase();
  if (!resourceUrl) return fail(request, 400, 'Falta resourceUrl');
  if (!isAllowedImage(mimeType)) return fail(request, 415, 'Formato no soportado');

  const filename = safeFilename(body.filename, 'diseno');

  try {
    const file = await fileCreate({
      resourceUrl,
      mimeType,
      filename,
      alt: `Diseño de cliente — ${filename}`,
    });
    const ready = await waitForFile(file.id);

    let spec = null;
    if (ready.width && ready.height) {
      spec = printSpec({
        sourceW: ready.width,
        sourceH: ready.height,
        size: body.size,
        posX: body.posX,
        posY: body.posY,
        zoom: body.zoom,
      });
    }

    return json(request, 200, {
      ok: true,
      designId: ready.id,
      originalUrl: ready.url,
      width: ready.width,
      height: ready.height,
      spec,
    });
  } catch (err) {
    console.error('[finalize]', err);
    return fail(request, 502, 'No se pudo registrar el diseño', {
      detail: String(err.message || err),
    });
  }
}
