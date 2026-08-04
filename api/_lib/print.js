/**
 * Geometría de impresión de MexPads.
 *
 * Todo diseño vive sobre un "maestro" de 36 x 17 in. Cada talla recorta una
 * ventana de pulgadas reales sobre ese maestro, y el cliente mueve esa ventana
 * con posX/posY y la acerca con zoom. La vista previa del sitio hace exactamente
 * esta cuenta en CSS (App.dc.html → _crop); aquí la repetimos en píxeles para
 * generar el archivo que se sublima.
 *
 * Regla que no se puede romper: lo que el cliente encuadró en pantalla es lo que
 * sale del RIP. Si estas fórmulas cambian, cámbialas también en _crop y _cornerDark.
 */

export const MASTER_W_IN = 36;
export const MASTER_H_IN = 17;

export const SIZES = {
  M: { inches: [12, 12], label: '12x12 in', name: 'Compacto' },
  L: { inches: [17, 17], label: '17x17 in', name: 'Cuadrado' },
  XL: { inches: [36, 17], label: '36x17 in', name: 'Panorámico' },
};

export const DEFAULT_DPI = 300;
export const DEFAULT_BLEED_MM = 3;
/** Debajo de esto la sublimación se ve suave/pixelada y hay que avisar. */
export const MIN_SAFE_DPI = 150;

export function sizeKeyOf(raw) {
  const k = String(raw || '').toUpperCase();
  return SIZES[k] ? k : 'XL';
}

export function clampZoom(z) {
  const n = Number(z);
  if (!Number.isFinite(n)) return 1;
  return Math.max(1, Math.min(3, n));
}

export function clampPos(p) {
  const n = Number(p);
  if (!Number.isFinite(n)) return 50;
  return Math.max(0, Math.min(100, n));
}

/**
 * Recorte del maestro 36:17 sobre la imagen original (object-fit: cover).
 * Devuelve el rectángulo en píxeles de la fuente que corresponde al maestro.
 */
export function masterRect(sourceW, sourceH) {
  const masterAspect = MASTER_W_IN / MASTER_H_IN;
  const srcAspect = sourceW / sourceH;
  if (srcAspect > masterAspect) {
    // La fuente es más ancha que el maestro: sobra a los lados.
    const w = sourceH * masterAspect;
    return { x: (sourceW - w) / 2, y: 0, width: w, height: sourceH };
  }
  // La fuente es más alta: sobra arriba y abajo.
  const h = sourceW / masterAspect;
  return { x: 0, y: (sourceH - h) / 2, width: sourceW, height: h };
}

/**
 * Fracción del maestro que la talla deja ver, y de dónde arranca esa ventana.
 * Espejo exacto de _crop()/_cornerDark() del front.
 */
export function windowFractions(sizeKey, posX, posY, zoom) {
  const key = sizeKeyOf(sizeKey);
  const [wIn, hIn] = SIZES[key].inches;
  const z = clampZoom(zoom);
  const wFrac = wIn / MASTER_W_IN / z;
  const hFrac = hIn / MASTER_H_IN / z;
  return {
    wFrac,
    hFrac,
    x0: (1 - wFrac) * (clampPos(posX) / 100),
    y0: (1 - hFrac) * (clampPos(posY) / 100),
  };
}

function round(n, places = 2) {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

/**
 * Especificación completa de impresión para un pedido.
 *
 * @param {object} o
 * @param {number} o.sourceW  ancho en px del archivo que subió el cliente
 * @param {number} o.sourceH  alto en px
 * @param {string} o.size     'M' | 'L' | 'XL'
 * @param {number} o.posX     0-100, centro horizontal de la ventana
 * @param {number} o.posY     0-100
 * @param {number} o.zoom     1-3
 * @param {number} [o.dpi]
 * @param {number} [o.bleedMm]
 */
export function printSpec({ sourceW, sourceH, size, posX, posY, zoom, dpi, bleedMm }) {
  if (!(sourceW > 0) || !(sourceH > 0)) throw new Error('Dimensiones de origen inválidas');

  const key = sizeKeyOf(size);
  const [wIn, hIn] = SIZES[key].inches;
  const resolution = Number(dpi) > 0 ? Math.round(Number(dpi)) : DEFAULT_DPI;
  const bleed = Number.isFinite(Number(bleedMm)) ? Math.max(0, Number(bleedMm)) : DEFAULT_BLEED_MM;
  const bleedIn = bleed / 25.4;

  const master = masterRect(sourceW, sourceH);
  const win = windowFractions(key, posX, posY, zoom);

  // Rectángulo exacto del corte (trim) sobre la imagen original.
  const trimSrc = {
    x: master.x + win.x0 * master.width,
    y: master.y + win.y0 * master.height,
    width: win.wFrac * master.width,
    height: win.hFrac * master.height,
  };

  // Rectángulo entero que se le pide a sharp. Extraemos exactamente el corte y
  // el sangrado se genera después en espejo: así la geometría del corte queda
  // clavada y el registro nunca se desplaza.
  const left = Math.max(0, Math.min(Math.floor(trimSrc.x), Math.floor(sourceW) - 1));
  const top = Math.max(0, Math.min(Math.floor(trimSrc.y), Math.floor(sourceH) - 1));
  const extract = {
    left,
    top,
    width: Math.max(1, Math.min(Math.round(trimSrc.width), Math.floor(sourceW) - left)),
    height: Math.max(1, Math.min(Math.round(trimSrc.height), Math.floor(sourceH) - top)),
  };

  const trimPx = { width: Math.round(wIn * resolution), height: Math.round(hIn * resolution) };
  const bleedPx = Math.round(bleedIn * resolution);
  const canvas = { width: trimPx.width + bleedPx * 2, height: trimPx.height + bleedPx * 2 };

  // Cuántos píxeles reales del original caen dentro de una pulgada impresa.
  const effectiveDpi = Math.min(trimSrc.width / wIn, trimSrc.height / hIn);

  return {
    size: key,
    sizeLabel: SIZES[key].label,
    inches: { width: wIn, height: hIn },
    dpi: resolution,
    bleedMm: bleed,
    bleedPx,
    source: { width: Math.round(sourceW), height: Math.round(sourceH) },
    master: {
      x: round(master.x),
      y: round(master.y),
      width: round(master.width),
      height: round(master.height),
    },
    window: {
      posX: clampPos(posX),
      posY: clampPos(posY),
      zoom: round(clampZoom(zoom), 3),
      xFrac: round(win.x0, 5),
      yFrac: round(win.y0, 5),
      wFrac: round(win.wFrac, 5),
      hFrac: round(win.hFrac, 5),
    },
    trimSrc: {
      x: round(trimSrc.x),
      y: round(trimSrc.y),
      width: round(trimSrc.width),
      height: round(trimSrc.height),
    },
    extract,
    trimPx,
    canvas,
    effectiveDpi: Math.round(effectiveDpi),
    lowRes: effectiveDpi < MIN_SAFE_DPI,
    // Qué tan grande debería ser el archivo del cliente para llegar a `dpi` con
    // este encuadre (el recorte sólo ve wFrac/hFrac del maestro).
    recommendedSource: {
      width: Math.ceil((wIn * resolution) / win.wFrac),
      height: Math.ceil((hIn * resolution) / win.hFrac),
    },
  };
}

/**
 * Posición del monograma MP sobre el área de corte, en píxeles del lienzo final.
 * Espeja el CSS de la vista previa: 7% de ancho, 4% del costado, 7% del borde inferior.
 */
export function monogramBox(spec, position) {
  const w = Math.round(spec.trimPx.width * 0.07);
  const side = Math.round(spec.trimPx.width * 0.04);
  const bottom = Math.round(spec.trimPx.height * 0.07);
  return {
    width: w,
    side,
    bottom,
    left: position === 'bl' ? spec.bleedPx + side : null,
    right: position === 'bl' ? null : spec.bleedPx + side,
  };
}

/** Texto corto y legible para el correo y para las propiedades del pedido. */
export function specSummary(spec) {
  return [
    `${spec.sizeLabel} @ ${spec.dpi} DPI`,
    `lienzo ${spec.canvas.width}x${spec.canvas.height} px (corte ${spec.trimPx.width}x${spec.trimPx.height} + ${spec.bleedMm} mm de sangrado)`,
    `origen ${spec.source.width}x${spec.source.height} px`,
    `recorte ${spec.trimSrc.width}x${spec.trimSrc.height} px @ (${spec.trimSrc.x}, ${spec.trimSrc.y})`,
    `zoom ${spec.window.zoom}x · pos ${spec.window.posX}/${spec.window.posY}`,
    `resolución efectiva ${spec.effectiveDpi} DPI${spec.lowRes ? ' ⚠ BAJA' : ''}`,
  ].join(' · ');
}
