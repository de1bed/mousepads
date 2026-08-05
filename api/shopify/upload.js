/**
 * POST /api/shopify/upload   { dataUrl, filename }
 *
 * Ruta de respaldo del flujo viejo: recibe la imagen en base64 y la sube.
 * Sólo sirve para archivos chicos — el cuerpo de una función serverless no
 * pasa de 4.5 MB, y en base64 eso son ~3 MB de imagen. El camino bueno es
 * stage → subida directa → finalize. Se queda para que un navegador con la
 * versión anterior en caché no se quede sin subir nada.
 */
import { uploadBuffer } from '../_lib/shopify.js';
import { fail, isAllowedImage, json, preflight, safeFilename } from '../_lib/http.js';

export const config = { runtime: 'nodejs', maxDuration: 60 };

const MAX_BYTES = 3 * 1024 * 1024;

export default async function handler(request) {
  if (request.method === 'OPTIONS') return preflight(request);
  if (request.method !== 'POST') return fail(request, 405, 'Método no permitido');

  let body;
  try {
    body = await request.json();
  } catch {
    return fail(request, 400, 'JSON inválido');
  }

  const m = String(body.dataUrl || '').match(/^data:([^;]+);base64,(.+)$/);
  if (!m) return fail(request, 400, 'dataUrl inválido');

  const mimeType = m[1].toLowerCase();
  if (!isAllowedImage(mimeType)) return fail(request, 415, 'Formato no soportado');

  const buffer = Buffer.from(m[2], 'base64');
  if (buffer.length > MAX_BYTES) {
    return fail(request, 413, 'Archivo demasiado grande para esta ruta; usa /api/design/stage');
  }

  const filename = `${Date.now()}-${safeFilename(body.filename, 'diseno.png')}`;

  try {
    const file = await uploadBuffer({
      buffer,
      filename,
      mimeType,
      alt: `Diseño de cliente — ${filename}`,
    });
    return json(request, 200, { ok: true, url: file.url, id: file.id, width: file.width, height: file.height });
  } catch (err) {
    console.error('[upload]', err);
    return fail(request, 502, 'No se pudo subir el diseño', { detail: String(err.message || err) });
  }
}
