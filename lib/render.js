/**
 * Genera el archivo que se manda a sublimar: recorte exacto de lo que el
 * cliente encuadró, al tamaño físico real, con sangrado y monograma quemado.
 */
import sharp from 'sharp';
import { monogramBox, printSpec } from './print.js';

/** Shopify Files rechaza archivos grandes; dejamos margen bajo los 20 MB. */
const MAX_UPLOAD_BYTES = 18 * 1024 * 1024;

const logoCache = new Map();

/**
 * Dimensiones tal y como se verán después de aplicar la orientación EXIF.
 * Sin esto, una foto de celular en vertical se recorta con el rectángulo
 * girado 90° y el pedido sale mal encuadrado.
 */
function orientedSize(meta) {
  const swap = Number(meta.orientation) >= 5 && Number(meta.orientation) <= 8;
  return swap
    ? { width: meta.height, height: meta.width }
    : { width: meta.width, height: meta.height };
}

async function fetchBuffer(url, { timeoutMs = 25_000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`No se pudo leer ${url} (HTTP ${res.status})`);
    return Buffer.from(await res.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

async function logoBuffer(baseUrl, ink) {
  const file = ink === 'blanco' ? 'logo-mp-blanco.png' : 'logo-mp-negro.png';
  if (logoCache.has(file)) return logoCache.get(file);
  const buf = await fetchBuffer(new URL(`/assets/brand/${file}`, baseUrl).href);
  logoCache.set(file, buf);
  return buf;
}

/**
 * Codifica intentando no pasarse del límite. Empieza en la mejor calidad y
 * sólo baja si el archivo no cabe — nunca al revés.
 */
async function encode(pipeline, { hasAlpha, dpi }) {
  if (hasAlpha) {
    const png = await pipeline
      .clone()
      .withMetadata({ density: dpi })
      .png({ compressionLevel: 9 })
      .toBuffer();
    if (png.length <= MAX_UPLOAD_BYTES) {
      return { buffer: png, ext: 'png', mimeType: 'image/png', quality: null };
    }
  }
  for (const quality of [95, 92, 88, 82]) {
    const jpg = await pipeline
      .clone()
      .flatten({ background: '#ffffff' })
      .withMetadata({ density: dpi })
      .jpeg({ quality, chromaSubsampling: '4:4:4', mozjpeg: true })
      .toBuffer();
    if (jpg.length <= MAX_UPLOAD_BYTES || quality === 82) {
      return { buffer: jpg, ext: 'jpg', mimeType: 'image/jpeg', quality };
    }
  }
  throw new Error('No se pudo comprimir el archivo de impresión');
}

/**
 * @param {object} o
 * @param {Buffer} o.source      bytes del archivo original del cliente
 * @param {string} o.size        'M' | 'L' | 'XL'
 * @param {number} o.posX
 * @param {number} o.posY
 * @param {number} o.zoom
 * @param {string} [o.monoPosition] 'bl' | 'br' | null → sin monograma
 * @param {string} [o.monoInk]      'blanco' | 'negro'
 * @param {string} o.baseUrl     origen público para leer los logos
 */
export async function renderPrintFile({
  source,
  size,
  posX,
  posY,
  zoom,
  monoPosition,
  monoInk,
  baseUrl,
  dpi,
  bleedMm,
}) {
  const probe = sharp(source, { limitInputPixels: 500_000_000, failOn: 'none' });
  const meta = await probe.metadata();
  if (!meta.width || !meta.height) throw new Error('No se pudo leer el archivo subido');
  const dims = orientedSize(meta);

  const spec = printSpec({
    sourceW: dims.width,
    sourceH: dims.height,
    size,
    posX,
    posY,
    zoom,
    dpi,
    bleedMm,
  });

  // 1) Recorte exacto → 2) al tamaño físico → 3) sangrado en espejo.
  let pipeline = sharp(source, { limitInputPixels: 500_000_000, failOn: 'none' })
    .rotate() // respeta la orientación EXIF antes de medir nada
    .extract(spec.extract)
    .resize(spec.trimPx.width, spec.trimPx.height, {
      fit: 'fill',
      kernel: 'lanczos3',
      withoutEnlargement: false,
    });

  if (spec.bleedPx > 0) {
    pipeline = pipeline.extend({
      top: spec.bleedPx,
      bottom: spec.bleedPx,
      left: spec.bleedPx,
      right: spec.bleedPx,
      extendWith: 'mirror',
    });
  }

  pipeline = pipeline.withMetadata({ density: spec.dpi }).toColourspace('srgb');

  if (monoPosition === 'bl' || monoPosition === 'br') {
    const box = monogramBox(spec, monoPosition);
    const raw = await logoBuffer(baseUrl, monoInk === 'blanco' ? 'blanco' : 'negro');

    // Calculamos el alto escalado a partir del logo original para poder
    // componer dentro del mismo pipeline. Materializar el lienzo completo sólo
    // para medir el logo duplicaría la memoria justo en el tamaño XL.
    const rawMeta = await sharp(raw).metadata();
    const logoH = Math.max(1, Math.round((rawMeta.height * box.width) / rawMeta.width));
    const logo = await sharp(raw)
      .resize(box.width, logoH, { fit: 'fill', kernel: 'lanczos3' })
      .png()
      .toBuffer();

    const top = spec.canvas.height - spec.bleedPx - box.bottom - logoH;
    const left = box.left != null
      ? box.left
      : spec.canvas.width - spec.bleedPx - box.side - box.width;

    pipeline = pipeline.composite([
      { input: logo, top: Math.max(0, Math.round(top)), left: Math.max(0, Math.round(left)) },
    ]);
  }

  const out = await encode(pipeline, { hasAlpha: !!meta.hasAlpha, dpi: spec.dpi });

  return {
    spec,
    buffer: out.buffer,
    ext: out.ext,
    mimeType: out.mimeType,
    quality: out.quality,
    bytes: out.buffer.length,
  };
}

/** Miniatura para el carrito y el correo: mismo encuadre, tamaño de pantalla. */
export async function renderPreview({ source, size, posX, posY, zoom, width = 640 }) {
  const meta = await sharp(source, { failOn: 'none' }).metadata();
  const dims = orientedSize(meta);
  const spec = printSpec({
    sourceW: dims.width,
    sourceH: dims.height,
    size,
    posX,
    posY,
    zoom,
  });
  const height = Math.round((width * spec.inches.height) / spec.inches.width);
  const buffer = await sharp(source, { failOn: 'none' })
    .rotate()
    .extract(spec.extract)
    .resize(width, height, { fit: 'fill', kernel: 'lanczos3' })
    .jpeg({ quality: 82 })
    .toBuffer();
  return { buffer, mimeType: 'image/jpeg', width, height };
}

export { fetchBuffer };
