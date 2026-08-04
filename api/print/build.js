/**
 * POST /api/print/build   { order: "1234" | "#1234" | "gid://shopify/Order/1234" }
 * Cabecera: x-mexpads-key: <ADMIN_API_KEY>
 *
 * Vuelve a generar el paquete de impresión de un pedido y lo reenvía por
 * correo. Es la salida cuando el webhook falló, cuando se cambió el DPI, o
 * cuando alguien borró el archivo por error.
 */
import { adminGql, shopDomain, tagOrderWithPrintPackage } from '../_lib/shopify.js';
import { buildLinePrintFile } from '../_lib/package.js';
import { printPackageEmail, sendMail } from '../_lib/mail.js';
import { fail, json, preflight, publicBaseUrl } from '../_lib/http.js';

export const config = { runtime: 'nodejs', maxDuration: 60 };

const ORDER_QUERY = `query order($id: ID!) {
  order(id: $id) {
    id
    name
    email
    createdAt
    customer { firstName lastName }
    lineItems(first: 50) {
      nodes {
        id
        title
        quantity
        variantTitle
        customAttributes { key value }
      }
    }
  }
}`;

function toGid(raw) {
  const s = String(raw || '').trim();
  if (s.startsWith('gid://')) return s;
  const digits = s.replace(/[^0-9]/g, '');
  return digits ? `gid://shopify/Order/${digits}` : null;
}

export default async function handler(request) {
  if (request.method === 'OPTIONS') return preflight(request);
  if (request.method !== 'POST') return fail(request, 405, 'Método no permitido');

  const key = process.env.ADMIN_API_KEY;
  if (!key) return fail(request, 503, 'ADMIN_API_KEY no configurada');
  if (request.headers.get('x-mexpads-key') !== key) return fail(request, 401, 'No autorizado');

  let body;
  try {
    body = await request.json();
  } catch {
    return fail(request, 400, 'JSON inválido');
  }

  const gid = toGid(body.order);
  if (!gid) return fail(request, 400, 'Falta el número de pedido');

  try {
    const data = await adminGql(ORDER_QUERY, { id: gid });
    const order = data?.order;
    if (!order) return fail(request, 404, 'Pedido no encontrado');

    const baseUrl = publicBaseUrl(request);
    const results = [];
    for (const node of order.lineItems.nodes) {
      results.push(await buildLinePrintFile(
        {
          id: node.id,
          title: node.title,
          quantity: node.quantity,
          variant_title: node.variantTitle,
          customAttributes: node.customAttributes,
        },
        { baseUrl, orderName: order.name }
      ));
    }

    const custom = results.filter((r) => !r.skipped);
    if (!custom.length) return json(request, 200, { ok: true, handled: 0, note: 'sin diseños de cliente' });

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

    await tagOrderWithPrintPackage(order.id, {
      generatedAt: new Date().toISOString(),
      rebuilt: true,
      items: items.map((i) => ({
        design: i.title,
        size: i.spec?.sizeLabel || null,
        effectiveDpi: i.spec?.effectiveDpi || null,
        lowRes: i.spec?.lowRes || false,
        printUrl: i.printUrl,
        error: i.error,
      })),
    }).catch((err) => console.error('[build] metafield: %s', err.message || err));

    const store = shopDomain().replace('.myshopify.com', '');
    const mail = printPackageEmail({
      order: {
        name: order.name,
        email: order.email,
        customerName: [order.customer?.firstName, order.customer?.lastName].filter(Boolean).join(' '),
        createdAt: order.createdAt,
      },
      items,
      storeAdminUrl: `https://admin.shopify.com/store/${store}/orders/${order.id.split('/').pop()}`,
    });
    const mailResult = await sendMail(mail).catch((err) => {
      console.error('[build] correo: %s', err.message || err);
      return { sent: false };
    });

    return json(request, 200, {
      ok: true,
      order: order.name,
      handled: custom.length,
      failed: custom.filter((r) => r.error).length,
      mailed: mailResult.sent,
      items: items.map((i) => ({ title: i.title, printUrl: i.printUrl, error: i.error })),
    });
  } catch (err) {
    console.error('[build]', err);
    return fail(request, 502, 'No se pudo rehacer el paquete', { detail: String(err.message || err) });
  }
}
