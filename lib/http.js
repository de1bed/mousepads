/** Utilidades comunes de las funciones (handlers estilo Web: Request → Response). */

const DEFAULT_ORIGINS = ['https://mexpads.com', 'https://www.mexpads.com'];

function allowedOrigins() {
  const extra = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return [...DEFAULT_ORIGINS, ...extra];
}

export function corsHeaders(request) {
  const origin = request.headers.get('origin') || '';
  const list = allowedOrigins();
  const ok = list.includes(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  return {
    'Access-Control-Allow-Origin': ok ? origin : list[0],
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

export function json(request, status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders(request) },
  });
}

export function preflight(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}

export function fail(request, status, message, extra) {
  return json(request, status, { ok: false, error: message, ...(extra || {}) });
}

/** Origen público del sitio, para resolver rutas de assets desde el servidor. */
export function publicBaseUrl(request) {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/$/, '');
  const origin = request.headers.get('origin');
  if (origin && /^https?:\/\//.test(origin)) return origin;
  const host = request.headers.get('x-forwarded-host') || request.headers.get('host');
  if (host) return `https://${host}`;
  return 'https://mexpads.com';
}

export function safeFilename(name, fallback = 'diseno') {
  const clean = String(name || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
  return clean || fallback;
}

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/svg+xml', 'image/heic', 'image/heif']);

export function isAllowedImage(mimeType) {
  return IMAGE_TYPES.has(String(mimeType || '').toLowerCase());
}
