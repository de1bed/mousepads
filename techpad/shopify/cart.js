/**
 * MexPads ↔ Shopify Storefront (token público, sólo lectura de catálogo y carrito).
 * El inventario nunca se expone en la tienda.
 *
 * Subida de diseños en tres pasos, para que el archivo del cliente llegue
 * íntegro y con el encuadre exacto:
 *   1. /api/design/stage     → pedimos un destino temporal a Shopify
 *   2. POST directo a ese destino  → el archivo NO pasa por nuestra función,
 *                                    así que no lo limita el tope de 4.5 MB
 *   3. /api/design/finalize  → se registra en Shopify Files y nos devuelve la
 *                              ficha de impresión (incluye el aviso de baja
 *                              resolución, que se muestra ANTES de pagar)
 * El archivo listo para sublimar lo genera el webhook orders/create.
 */
(function (global) {
  const SHOP = 'mexpads.myshopify.com';
  const STOREFRONT_TOKEN = '5f51e3ff20f2f655b5f96267b105b0e1';
  const API = 'https://' + SHOP + '/api/2025-01/graphql.json';

  // Filled/updated by sync-catalog.mjs → variant-map.json (inlined snapshot)
  const CUSTOM = {
    M: 'gid://shopify/ProductVariant/46252401033402',
    L: 'gid://shopify/ProductVariant/46252401131706',
    XL: 'gid://shopify/ProductVariant/46252401164474'
  };

  let PRODUCT_VARIANTS = {};

  async function loadVariantMap() {
    try {
      const res = await fetch('./shopify/variant-map.json', { cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json();
      if (data.custom) {
        if (data.custom.M) CUSTOM.M = data.custom.M;
        if (data.custom.L) CUSTOM.L = data.custom.L;
        if (data.custom.XL) CUSTOM.XL = data.custom.XL;
      }
      PRODUCT_VARIANTS = data.products || {};
    } catch (e) { /* map optional until sync */ }
  }

  async function gql(query, variables) {
    const res = await fetch(API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Storefront-Access-Token': STOREFRONT_TOKEN
      },
      body: JSON.stringify({ query, variables })
    });
    const json = await res.json();
    if (json.errors?.length) throw new Error(json.errors.map((e) => e.message).join('; '));
    return json.data;
  }

  function sizeLabel(sizeKey) {
    return ({ M: '12x12 in', L: '17x17 in', XL: '36x17 in' })[sizeKey] || sizeKey;
  }

  function variantForCatalog(slug, sizeKey) {
    const p = PRODUCT_VARIANTS[slug];
    if (!p) return null;
    return p[sizeKey] || null;
  }

  function variantForCustom(sizeKey) {
    return CUSTOM[sizeKey] || CUSTOM.XL;
  }

  async function apiJson(path, body) {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    let json = null;
    try { json = await res.json(); } catch (e) { /* respuesta sin cuerpo */ }
    if (!res.ok || !json || json.ok === false) {
      const msg = (json && (json.error || json.detail)) || ('HTTP ' + res.status);
      throw new Error(msg);
    }
    return json;
  }

  /** POST del archivo al destino temporal, con progreso real de subida. */
  function postToTarget(target, file, onProgress) {
    return new Promise((resolve, reject) => {
      const form = new FormData();
      (target.parameters || []).forEach((p) => form.append(p.name, p.value));
      form.append('file', file, target.filename || file.name || 'diseno');

      const xhr = new XMLHttpRequest();
      xhr.open('POST', target.url, true);
      if (onProgress) {
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
        };
      }
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) resolve();
        else reject(new Error('Subida falló (HTTP ' + xhr.status + ')'));
      };
      xhr.onerror = () => reject(new Error('Se cortó la conexión al subir el diseño'));
      xhr.ontimeout = () => reject(new Error('La subida tardó demasiado'));
      xhr.timeout = 180000;
      xhr.send(form);
    });
  }

  /**
   * Sube el diseño del cliente y devuelve su ficha.
   * @param {File} file
   * @param {{size?:string, posX?:number, posY?:number, zoom?:number, onProgress?:function}} opts
   * @returns {Promise<{designId:string, originalUrl:string, width:number, height:number, spec:object}>}
   */
  async function uploadDesign(file, opts) {
    const o = opts || {};
    if (!file) throw new Error('No hay archivo que subir');

    const staged = await apiJson('/api/design/stage', {
      filename: file.name || 'diseno.png',
      mimeType: file.type || 'image/png',
      fileSize: file.size
    });

    await postToTarget(staged, file, o.onProgress);

    return apiJson('/api/design/finalize', {
      resourceUrl: staged.resourceUrl,
      filename: staged.filename,
      mimeType: file.type || 'image/png',
      size: o.size || 'XL',
      posX: o.posX,
      posY: o.posY,
      zoom: o.zoom
    });
  }

  /**
   * Recalcula la ficha de impresión con un encuadre nuevo, sin volver a subir.
   * Se usa cuando el cliente cambia de talla o mueve el recorte después de subir.
   */
  function respec(design, size, posX, posY, zoom) {
    if (!design || !design.width || !design.height) return null;
    const INCHES = { M: [12, 12], L: [17, 17], XL: [36, 17] };
    const dim = INCHES[size] || INCHES.XL;
    const z = Math.max(1, Math.min(3, Number(zoom) || 1));
    const wFrac = (dim[0] / 36) / z;
    const hFrac = (dim[1] / 17) / z;

    // Mismo maestro 36:17 que usa el servidor (object-fit: cover).
    const masterAspect = 36 / 17;
    const srcAspect = design.width / design.height;
    const masterW = srcAspect > masterAspect ? design.height * masterAspect : design.width;
    const masterH = srcAspect > masterAspect ? design.height : design.width / masterAspect;

    const cropW = wFrac * masterW;
    const cropH = hFrac * masterH;
    const effectiveDpi = Math.round(Math.min(cropW / dim[0], cropH / dim[1]));

    return {
      size: size,
      sizeLabel: sizeLabel(size),
      inches: { width: dim[0], height: dim[1] },
      dpi: 300,
      effectiveDpi: effectiveDpi,
      lowRes: effectiveDpi < 150,
      recommendedSource: {
        width: Math.ceil((dim[0] * 300) / wFrac),
        height: Math.ceil((dim[1] * 300) / hFrac)
      }
    };
  }

  function num(v, fallback) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }

  /**
   * Propiedades de línea. Las que empiezan con "_" no se le muestran al cliente
   * en el checkout: son los datos que necesita producción, no él.
   */
  function attrsFromCartItem(it) {
    const attrs = [];
    const push = (key, value) => {
      if (value == null || value === '') return;
      attrs.push({ key, value: String(value).slice(0, 500) });
    };

    push('Tamano', it.sizeLabel || sizeLabel(it.size));
    push('Tipo', it.kind === 'custom' || it.custom ? 'Personalizado' : 'Catalogo');
    if (it.slug) push('Diseno_slug', it.slug);
    if (it.designName) push('Diseno', it.designName);
    if (it.designUrl) push('Diseno_URL', it.designUrl);
    if (it.note) push('Notas', it.note);

    // Lo que lee el motor de impresión. Números, no texto que haya que adivinar.
    push('_size', it.size || 'XL');
    push('_crop', JSON.stringify({
      size: it.size || 'XL',
      posX: num(it.posX, 50),
      posY: num(it.posY, 50),
      zoom: num(it.zoom, 1)
    }));
    push('_mono', JSON.stringify({
      position: it.monoPos || null,
      ink: it.monoInk || null
    }));
    if (it.designId) push('_design_id', it.designId);
    if (it.designW && it.designH) push('_design_px', it.designW + 'x' + it.designH);

    // Versión legible, para que el pedido se entienda de un vistazo en el admin.
    push('Recorte', 'x:' + Math.round(num(it.posX, 50)) +
      ' y:' + Math.round(num(it.posY, 50)) +
      ' z:' + (Math.round(num(it.zoom, 1) * 100) / 100));
    push('Monograma', it.mono || 'sin');
    if (it.color) push('Color_base', it.color);

    return attrs;
  }

  async function checkout(cartItems) {
    if (!cartItems || !cartItems.length) throw new Error('Carrito vacío');
    await loadVariantMap();

    const lines = [];
    for (const it of cartItems) {
      let merchandiseId = it.variantId;
      if (!merchandiseId) {
        if (it.custom || it.kind === 'custom') merchandiseId = variantForCustom(it.size || 'XL');
        else merchandiseId = variantForCatalog(it.slug, it.size || 'XL');
      }
      if (!merchandiseId) {
        // Fallback: custom XL so checkout still works
        merchandiseId = variantForCustom(it.size || 'XL');
      }

      // Red de seguridad: si el diseño no alcanzó a subirse cuando el cliente lo
      // eligió, se sube ahora. Sin esto, el pedido llega sin archivo.
      let item = it;
      if ((it.custom || it.kind === 'custom') && !it.designUrl && it.designFile) {
        try {
          const up = await uploadDesign(it.designFile, {
            size: it.size, posX: it.posX, posY: it.posY, zoom: it.zoom
          });
          item = Object.assign({}, it, {
            designUrl: up.originalUrl,
            designId: up.designId,
            designW: up.width,
            designH: up.height
          });
        } catch (e) {
          console.error('[cart] no se pudo subir el diseño en el checkout', e);
        }
      }

      lines.push({
        merchandiseId,
        quantity: Math.max(1, Number(item.qty) || 1),
        attributes: attrsFromCartItem(item)
      });
    }

    const data = await gql(
      `mutation cartCreate($input: CartInput!) {
        cartCreate(input: $input) {
          cart { id checkoutUrl totalQuantity }
          userErrors { message field }
        }
      }`,
      {
        input: {
          lines,
          note: 'Pedido MexPads — diseño/tamaño/recorte en propiedades de línea.',
          attributes: [{ key: 'source', value: 'mexpads-web' }]
        }
      }
    );
    const err = data.cartCreate.userErrors;
    if (err?.length) throw new Error(err.map((e) => e.message).join('; '));
    const url = data.cartCreate.cart?.checkoutUrl;
    if (!url) throw new Error('No se pudo crear el checkout');
    return url;
  }

  global.MexPadsShopify = {
    SHOP, CUSTOM, loadVariantMap, checkout, sizeLabel,
    uploadDesign, respec, variantForCatalog, variantForCustom
  };
})(typeof window !== 'undefined' ? window : globalThis);
