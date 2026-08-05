/**
 * Envío de correo. Usa Resend si hay API key; si no, deja el paquete en los
 * logs de la función para que nunca se pierda un pedido por falta de config.
 */

export function mailConfigured() {
  return !!process.env.RESEND_API_KEY;
}

export function printInbox() {
  return (process.env.PRINT_EMAIL_TO || 'davidrocha0520@gmail.com')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function sendMail({ subject, html, text, replyTo }) {
  const to = printInbox();
  const from = process.env.PRINT_EMAIL_FROM || 'MexPads <onboarding@resend.dev>';

  if (!mailConfigured()) {
    console.warn('[mail] RESEND_API_KEY no configurada; el paquete queda sólo en logs');
    console.warn('[mail] para=%s asunto=%s', to.join(','), subject);
    console.warn('[mail] %s', text);
    return { sent: false, reason: 'missing_api_key' };
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to,
      subject,
      html,
      text,
      ...(replyTo ? { reply_to: replyTo } : {}),
    }),
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Resend ${res.status}: ${body.message || JSON.stringify(body).slice(0, 200)}`);
  }
  return { sent: true, id: body.id || null };
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Hoja de producción: un correo por pedido, con todo lo que necesita quien
 * imprime — archivo listo, medidas exactas y aviso si el original venía chico.
 */
export function printPackageEmail({ order, items, storeAdminUrl }) {
  const anyLowRes = items.some((it) => it.spec?.lowRes);
  const subject = `${anyLowRes ? '⚠ ' : ''}MexPads ${order.name} — ${items.length} diseño${items.length === 1 ? '' : 's'} para imprimir`;

  const rows = items.map((it, i) => {
    const s = it.spec || {};
    const warn = s.lowRes
      ? `<p style="margin:8px 0;padding:10px 12px;background:#FFF4E5;border-left:3px solid #E8811F;font-size:13px">
           <strong>Resolución baja:</strong> el original da ${esc(s.effectiveDpi)} DPI en este encuadre.
           Para ${esc(s.sizeLabel)} a ${esc(s.dpi)} DPI harían falta ~${esc(s.recommendedSource?.width)}x${esc(s.recommendedSource?.height)} px.
           Revisa antes de sublimar.
         </p>`
      : '';
    return `
      <tr><td style="padding:20px 0;border-top:1px solid #E5E5E5">
        <p style="margin:0 0 6px;font-size:15px;font-weight:700">${i + 1}. ${esc(it.title)}</p>
        <p style="margin:0 0 12px;font-size:13px;color:#666">${esc(it.variantTitle || '')} · cantidad ${esc(it.quantity)}</p>
        ${warn}
        <table cellpadding="0" cellspacing="0" style="font-size:13px;line-height:1.7">
          <tr><td style="color:#666;padding-right:16px">Tamaño</td><td><strong>${esc(s.sizeLabel)}</strong> (${esc(s.inches?.width)} x ${esc(s.inches?.height)} in)</td></tr>
          <tr><td style="color:#666;padding-right:16px">Lienzo</td><td>${esc(s.canvas?.width)} x ${esc(s.canvas?.height)} px @ ${esc(s.dpi)} DPI</td></tr>
          <tr><td style="color:#666;padding-right:16px">Corte</td><td>${esc(s.trimPx?.width)} x ${esc(s.trimPx?.height)} px · sangrado ${esc(s.bleedMm)} mm (${esc(s.bleedPx)} px por lado)</td></tr>
          <tr><td style="color:#666;padding-right:16px">Encuadre</td><td>zoom ${esc(s.window?.zoom)}x · posición ${esc(s.window?.posX)}/${esc(s.window?.posY)}</td></tr>
          <tr><td style="color:#666;padding-right:16px">Original</td><td>${esc(s.source?.width)} x ${esc(s.source?.height)} px</td></tr>
          <tr><td style="color:#666;padding-right:16px">Resolución real</td><td>${esc(s.effectiveDpi)} DPI</td></tr>
          <tr><td style="color:#666;padding-right:16px">Monograma</td><td>${esc(it.monogram || 'sin')}</td></tr>
        </table>
        <p style="margin:14px 0 0">
          ${it.printUrl ? `<a href="${esc(it.printUrl)}" style="display:inline-block;padding:11px 18px;background:#111;color:#fff;text-decoration:none;font-size:13px;font-weight:700">DESCARGAR ARCHIVO LISTO</a>` : '<span style="color:#C0392B;font-size:13px">Sin archivo de impresión — revisar en el admin</span>'}
          ${it.originalUrl ? `<a href="${esc(it.originalUrl)}" style="display:inline-block;margin-left:10px;padding:11px 18px;border:1px solid #111;color:#111;text-decoration:none;font-size:13px;font-weight:700">ORIGINAL</a>` : ''}
        </p>
      </td></tr>`;
  }).join('');

  const html = `<!doctype html><html><body style="margin:0;background:#F5F5F5;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111">
    <div style="max-width:640px;margin:0 auto;background:#fff;padding:32px">
      <p style="margin:0 0 4px;font-size:12px;letter-spacing:.12em;color:#888;text-transform:uppercase">MexPads · producción</p>
      <h1 style="margin:0 0 4px;font-size:24px">Pedido ${esc(order.name)}</h1>
      <p style="margin:0 0 24px;font-size:13px;color:#666">
        ${esc(order.customerName || 'Cliente')}${order.email ? ` · ${esc(order.email)}` : ''}
        ${order.createdAt ? ` · ${esc(new Date(order.createdAt).toLocaleString('es-MX'))}` : ''}
      </p>
      ${anyLowRes ? '<p style="margin:0 0 20px;padding:12px 14px;background:#FFF4E5;border-left:3px solid #E8811F;font-size:13px"><strong>Ojo:</strong> este pedido trae al menos un diseño por debajo de la resolución recomendada.</p>' : ''}
      <table cellpadding="0" cellspacing="0" width="100%">${rows}</table>
      ${storeAdminUrl ? `<p style="margin:28px 0 0;font-size:13px"><a href="${esc(storeAdminUrl)}" style="color:#111">Ver el pedido en Shopify →</a></p>` : ''}
    </div>
  </body></html>`;

  const text = [
    `MexPads — pedido ${order.name}`,
    order.customerName || '',
    order.email || '',
    '',
    ...items.map((it, i) => {
      const s = it.spec || {};
      return [
        `${i + 1}. ${it.title} (${it.variantTitle || ''}) x${it.quantity}`,
        `   Tamaño: ${s.sizeLabel} · lienzo ${s.canvas?.width}x${s.canvas?.height} px @ ${s.dpi} DPI`,
        `   Corte ${s.trimPx?.width}x${s.trimPx?.height} px + ${s.bleedMm} mm sangrado`,
        `   Encuadre zoom ${s.window?.zoom}x pos ${s.window?.posX}/${s.window?.posY}`,
        `   Resolución real: ${s.effectiveDpi} DPI${s.lowRes ? '  ** BAJA **' : ''}`,
        `   Monograma: ${it.monogram || 'sin'}`,
        `   Archivo listo: ${it.printUrl || '(no generado)'}`,
        `   Original: ${it.originalUrl || '(no disponible)'}`,
      ].join('\n');
    }),
  ].join('\n');

  return { subject, html, text };
}
