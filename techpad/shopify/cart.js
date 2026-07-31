/**
 * MexPads ↔ Shopify Storefront (browser-safe token).
 * Inventory is never exposed to the UI.
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

  function attrsFromCartItem(it) {
    const attrs = [];
    const push = (key, value) => {
      if (value == null || value === '') return;
      attrs.push({ key, value: String(value).slice(0, 500) });
    };
    push('Tamano', it.sizeLabel || sizeLabel(it.size));
    push('Tipo', it.kind || (it.custom ? 'Personalizado' : 'Catalogo'));
    if (it.slug) push('Diseno_slug', it.slug);
    if (it.designName) push('Diseno', it.designName);
    if (it.designUrl) push('Diseno_URL', it.designUrl);
    if (it.crop) push('Recorte', it.crop);
    if (it.mono) push('Monograma', it.mono);
    if (it.color) push('Color_base', it.color);
    if (it.note) push('Notas', it.note);
    return attrs;
  }

  /**
   * Upload design via optional local/API bridge; falls back to data URL skip.
   * Bridge: POST /api/shopify/upload  { file base64, filename } -> { url }
   */
  async function uploadDesign(fileOrDataUrl, filename) {
    try {
      const res = await fetch('/api/shopify/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dataUrl: fileOrDataUrl, filename: filename || 'diseno.png' })
      });
      if (!res.ok) return null;
      const j = await res.json();
      return j.url || null;
    } catch (e) {
      return null;
    }
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
      let designUrl = it.designUrl;
      if (it.designDataUrl && !designUrl) {
        designUrl = await uploadDesign(it.designDataUrl, it.designName || 'diseno.png');
      }
      const enriched = Object.assign({}, it, { designUrl });
      lines.push({
        merchandiseId,
        quantity: Math.max(1, Number(it.qty) || 1),
        attributes: attrsFromCartItem(enriched)
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
    SHOP, CUSTOM, loadVariantMap, checkout, sizeLabel, uploadDesign, variantForCatalog, variantForCustom
  };
})(typeof window !== 'undefined' ? window : globalThis);
