/**
 * POST /api/design/stage
 *
 * Devuelve un destino de subida directa a Shopify. El navegador manda el
 * archivo ahí, no aquí: el original llega completo, sin pasar por el límite de
 * 4.5 MB de cuerpo que tienen las funciones.
 *
 * body: { filename, mimeType, fileSize }
 * →     { ok, url, resourceUrl, parameters[] }
 */
import { createStagedUpload } from '../../lib/shopify.js';
import { fail, isAllowedImage, json, preflight, safeFilename } from '../../lib/http.js';

export const config = { runtime: 'nodejs', maxDuration: 30 };

const MAX_BYTES = 60 * 1024 * 1024;

export default async function handler(request) {
  if (request.method === 'OPTIONS') return preflight(request);
  if (request.method !== 'POST') return fail(request, 405, 'Método no permitido');

  let body;
  try {
    body = await request.json();
  } catch {
    return fail(request, 400, 'JSON inválido');
  }

  const mimeType = String(body.mimeType || '').toLowerCase();
  const fileSize = Number(body.fileSize);

  if (!isAllowedImage(mimeType)) {
    return fail(request, 415, 'Formato no soportado. Usa JPG, PNG, WEBP o SVG.');
  }
  if (!(fileSize > 0)) return fail(request, 400, 'fileSize inválido');
  if (fileSize > MAX_BYTES) {
    return fail(request, 413, `El archivo pasa de ${Math.round(MAX_BYTES / 1024 / 1024)} MB.`);
  }

  const filename = `${Date.now()}-${safeFilename(body.filename, 'diseno')}`;

  try {
    const target = await createStagedUpload({ filename, mimeType, fileSize });
    return json(request, 200, {
      ok: true,
      filename,
      url: target.url,
      resourceUrl: target.resourceUrl,
      parameters: target.parameters,
    });
  } catch (err) {
    console.error('[stage]', err);
    return fail(request, 502, 'No se pudo preparar la subida', { detail: String(err.message || err) });
  }
}
