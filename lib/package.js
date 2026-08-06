/**
 * Arma el paquete de impresión de un pedido: por cada línea personalizada
 * genera el archivo listo para sublimar y lo deja en Shopify Files.
 *
 * Vive aparte de la ruta del webhook para poder re-ejecutarlo a mano cuando un
 * pedido haya que rehacerlo (POST /api/print/build).
 */
import { printSpec, sizeKeyOf, specSummary } from './print.js';
import { renderPrintFile, fetchBuffer } from './render.js';
import { uploadBuffer } from './shopify.js';
import { safeFilename } from './http.js';

/** Las propiedades de línea llegan como lista {name,value} o {key,value}. */
export function attrMap(properties) {
  const out = {};
  for (const p of properties || []) {
    const k = p.name ?? p.key;
    if (k == null) continue;
    out[String(k)] = p.value;
  }
  return out;
}

function parseJsonAttr(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Tolera el formato viejo "x:50 y:50 z:1" por si quedan pedidos en tránsito. */
function parseLegacyCrop(raw) {
  const m = String(raw || '').match(/x:\s*(-?[\d.]+)\s*y:\s*(-?[\d.]+)\s*z:\s*(-?[\d.]+)/i);
  if (!m) return null;
  return { posX: Number(m[1]), posY: Number(m[2]), zoom: Number(m[3]) };
}

function parseLegacyMono(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (!s || s === 'sin') return { position: null, ink: null };
  const [pos, ink] = s.split('/');
  return {
    position: pos === 'izq' ? 'bl' : pos === 'der' ? 'br' : null,
    ink: ink === 'blanco' ? 'blanco' : ink === 'negro' ? 'negro' : null,
  };
}

/** Normaliza una línea de pedido a lo que necesita el render. */
export function describeLine(line) {
  const a = attrMap(line.properties || line.customAttributes || []);
  const crop = parseJsonAttr(a._crop) || parseLegacyCrop(a.Recorte) || {};
  const mono = parseJsonAttr(a._mono) || parseLegacyMono(a.Monograma);

  return {
    id: line.id,
    title: line.title || line.name || 'Mousepad',
    variantTitle: line.variant_title || a.Tamano || null,
    quantity: line.quantity || 1,
    kind: String(a.Tipo || '').trim().toLowerCase() === 'personalizado' ? 'custom' : 'catalog',
    // Produccion procesa uploads y arte predeterminado. Antes `isCustom`
    // descartaba el catalogo aunque la linea ya trajera su archivo original.
    isCustom: String(a.Tipo || '').toLowerCase() === 'personalizado' || !!a._design_id,
    isPrintable: !!a.Diseno_URL,
    designId: a._design_id || null,
    designName: a.Diseno || null,
    originalUrl: a.Diseno_URL || null,
    size: sizeKeyOf(crop.size || a._size),
    posX: crop.posX,
    posY: crop.posY,
    zoom: crop.zoom,
    monoPosition: mono?.position || null,
    monoInk: mono?.ink || null,
    monogram: a.Monograma || 'sin',
  };
}

/**
 * Genera y sube el archivo de impresión de una línea.
 * Nunca lanza: si algo falla devuelve el error dentro del resultado para que un
 * diseño roto no tumbe el correo de todo el pedido.
 */
export async function buildLinePrintFile(line, { baseUrl, orderName }) {
  const info = describeLine(line);
  if (!info.isPrintable || !info.originalUrl) {
    return { ...info, skipped: true, reason: 'sin archivo de diseño' };
  }

  try {
    const source = await fetchBuffer(info.originalUrl, { timeoutMs: 40_000 });

    const rendered = await renderPrintFile({
      source,
      size: info.size,
      posX: info.posX,
      posY: info.posY,
      zoom: info.zoom,
      monoPosition: info.monoPosition,
      monoInk: info.monoInk,
      baseUrl,
      dpi: Number(process.env.PRINT_DPI) || undefined,
      bleedMm: Number(process.env.PRINT_BLEED_MM) || undefined,
    });

    const base = safeFilename(
      `${orderName || 'pedido'}-${info.designName || 'diseno'}-${rendered.spec.sizeLabel}`,
      'impresion'
    );
    const uploaded = await uploadBuffer({
      buffer: rendered.buffer,
      filename: `PRINT-${base}.${rendered.ext}`,
      mimeType: rendered.mimeType,
      alt: `Archivo de impresión ${orderName || ''} — ${specSummary(rendered.spec)}`,
    });

    return {
      ...info,
      skipped: false,
      spec: rendered.spec,
      summary: specSummary(rendered.spec),
      printUrl: uploaded.url,
      printFileId: uploaded.id,
      bytes: rendered.bytes,
    };
  } catch (err) {
    console.error('[package] línea %s: %s', info.id, err.message || err);
    return { ...info, skipped: false, error: String(err.message || err) };
  }
}

/** Ficha de impresión sin renderizar, por si sólo se quiere la geometría. */
export function specForLine(line, sourceW, sourceH) {
  const info = describeLine(line);
  return printSpec({
    sourceW,
    sourceH,
    size: info.size,
    posX: info.posX,
    posY: info.posY,
    zoom: info.zoom,
  });
}
