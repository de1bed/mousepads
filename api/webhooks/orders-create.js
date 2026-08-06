/**
 * POST /api/webhooks/orders-create
 *
 * Webhook de Shopify (topic orders/create). Por cada línea con diseño de
 * cliente genera el archivo listo para sublimar, lo guarda en Shopify Files,
 * lo cuelga del pedido como metafield y manda la hoja de producción por correo.
 *
 * Configurar en Shopify → Notificaciones → Webhooks, formato JSON, y poner el
 * secreto en SHOPIFY_WEBHOOK_SECRET.
 */
import crypto from 'node:crypto';
import { buildLinePrintFile, describeLine } from '../../lib/package.js';
import { tagOrderWithPrintPackage, writeOrderNote, adminStoreHandle, adminOrderUrl } from '../../lib/shopify.js';
import { printPackageEmail, sendMail } from '../../lib/mail.js';
import { publicBaseUrl } from '../../lib/http.js';

export const config = { runtime: 'nodejs', maxDuration: 60 };

function verify(rawBody, header, secret) {
  if (!secret) return { ok: false, reason: 'SHOPIFY_WEBHOOK_SECRET no configurado' };
  if (!header) return { ok: false, reason: 'falta cabecera HMAC' };
  const digest = crypto.createHmac('sha256', secret).update(rawBody).digest('base64');
  const a = Buffer.from(digest);
  const b = Buffer.from(header);
  if (a.length !== b.length) return { ok: false, reason: 'HMAC no coincide' };
  return crypto.timingSafeEqual(a, b)
    ? { ok: true }
    : { ok: false, reason: 'HMAC no coincide' };
}

export default async function handler(request) {
  if (request.method !== 'POST') {
    return new Response('Método no permitido', { status: 405 });
  }

  const raw = Buffer.from(await request.arrayBuffer());
  const check = verify(
    raw,
    request.headers.get('x-shopify-hmac-sha256'),
    process.env.SHOPIFY_WEBHOOK_SECRET
  );
  if (!check.ok) {
    console.warn('[webhook] rechazado: %s', check.reason);
    return new Response('Unauthorized', { status: 401 });
  }

  let order;
  try {
    order = JSON.parse(raw.toString('utf8'));
  } catch {
    return new Response('JSON inválido', { status: 400 });
  }

  const baseUrl = publicBaseUrl(request);
  const orderName = order.name || `#${order.order_number || order.id}`;

  const lines = Array.isArray(order.line_items) ? order.line_items : [];
  const results = [];
  // La función tiene 60 s; guardamos margen para el correo y el metafield.
  const deadline = Date.now() + 45_000;
  for (const line of lines) {
    if (Date.now() > deadline) {
      // Mejor mandar la hoja con lo que sí salió y avisar, que morir a la mitad
      // y que el pedido se quede sin archivos. El resto se rehace con
      // POST /api/print/build.
      const info = describeLine(line);
      if (info.isPrintable) {
        results.push({ ...info, skipped: false, error: 'sin tiempo en esta ejecución — rehacer con /api/print/build' });
      }
      continue;
    }
    // En serie a propósito: un XL a 300 DPI son ~165 MB en memoria y en
    // paralelo la función se queda sin RAM justo cuando hay más pedidos.
    results.push(await buildLinePrintFile(line, { baseUrl, orderName }));
  }

  const custom = results.filter((r) => !r.skipped);
  if (!custom.length) {
    return Response.json({ ok: true, handled: 0, note: 'pedido sin archivos de diseño' });
  }

  const items = custom.map((r) => ({
    title: r.designName || r.title,
    variantTitle: r.variantTitle,
    quantity: r.quantity,
    monogram: r.monogram,
    spec: r.spec || null,
    printUrl: r.printUrl || null,
    originalUrl: r.originalUrl || null,
    error: r.error || null,
  }));

  const orderGid = order.admin_graphql_api_id || null;
  if (orderGid) {
    try {
      await tagOrderWithPrintPackage(orderGid, {
        generatedAt: new Date().toISOString(),
        items: items.map((i) => ({
          design: i.title,
          size: i.spec?.sizeLabel || null,
          dpi: i.spec?.dpi || null,
          effectiveDpi: i.spec?.effectiveDpi || null,
          lowRes: i.spec?.lowRes || false,
          printUrl: i.printUrl,
          originalUrl: i.originalUrl,
          error: i.error,
        })),
      });
    } catch (err) {
      console.error('[webhook] metafield: %s', err.message || err);
    }

    // La nota va siempre, haya correo o no: es la red de seguridad. Aunque
    // Resend no esté configurado, el archivo aparece en el propio pedido.
    try {
      await writeOrderNote(orderGid, items, order.note);
    } catch (err) {
      console.error('[webhook] nota del pedido: %s', err.message || err);
    }
  }

  const adminUrl = order.id ? adminOrderUrl(await adminStoreHandle(), order.id) : null;

  const mail = printPackageEmail({
    order: {
      name: orderName,
      email: order.email || order.contact_email || null,
      customerName: [order.customer?.first_name, order.customer?.last_name].filter(Boolean).join(' '),
      createdAt: order.created_at,
    },
    items,
    storeAdminUrl: adminUrl,
  });

  let mailResult = { sent: false };
  try {
    mailResult = await sendMail({ ...mail, replyTo: order.email || undefined });
  } catch (err) {
    console.error('[webhook] correo: %s', err.message || err);
  }

  return Response.json({
    ok: true,
    handled: custom.length,
    failed: custom.filter((r) => r.error).length,
    mailed: mailResult.sent,
  });
}
