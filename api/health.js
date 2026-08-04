/**
 * GET /api/health — qué está configurado y qué falta.
 * No revela ningún valor, sólo si existe.
 */
import { adminGql, shopDomain } from './_lib/shopify.js';
import { mailConfigured, printInbox } from './_lib/mail.js';
import { corsHeaders, preflight } from './_lib/http.js';

export const config = { runtime: 'nodejs', maxDuration: 30 };

export default async function handler(request) {
  if (request.method === 'OPTIONS') return preflight(request);

  const env = {
    shopDomain: shopDomain(),
    shopifyAuth: !!(process.env.SHOPIFY_ADMIN_TOKEN || (process.env.SHOPIFY_CLIENT_ID && process.env.SHOPIFY_CLIENT_SECRET)),
    webhookSecret: !!process.env.SHOPIFY_WEBHOOK_SECRET,
    adminApiKey: !!process.env.ADMIN_API_KEY,
    mail: mailConfigured(),
    mailTo: printInbox(),
    dpi: Number(process.env.PRINT_DPI) || 300,
    bleedMm: Number(process.env.PRINT_BLEED_MM) || 3,
  };

  let shopify = { reachable: false };
  if (env.shopifyAuth) {
    try {
      const data = await adminGql('{ shop { name currencyCode } }');
      shopify = { reachable: true, name: data?.shop?.name, currency: data?.shop?.currencyCode };
    } catch (err) {
      shopify = { reachable: false, error: String(err.message || err) };
    }
  }

  let sharpVersion = null;
  try {
    const sharp = (await import('sharp')).default;
    sharpVersion = sharp.versions?.vips || 'ok';
  } catch (err) {
    sharpVersion = 'ERROR: ' + String(err.message || err);
  }

  // Sin estas dos no hay pipeline. El correo es un extra: sin él, los enlaces
  // igual quedan escritos en la nota del pedido.
  const missing = [];
  if (!env.shopifyAuth) missing.push('SHOPIFY_ADMIN_TOKEN (o SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET)');
  if (!env.webhookSecret) missing.push('SHOPIFY_WEBHOOK_SECRET');

  const opcional = [];
  if (!env.mail) opcional.push('RESEND_API_KEY — sin esto no llega correo, pero los archivos sí quedan en la nota del pedido');
  if (!env.adminApiKey) opcional.push('ADMIN_API_KEY — sólo hace falta para rehacer un pedido con /api/print/build');

  return new Response(
    JSON.stringify({ ok: missing.length === 0, env, shopify, sharp: sharpVersion, missing, opcional }, null, 2),
    { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders(request) } }
  );
}
