/**
 * Sync MexPads catalog -> Shopify (Admin API, client credentials).
 * Usage: node techpad/shopify/sync-catalog.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DOMAIN = 'mexpads.myshopify.com';
const API = `https://${DOMAIN}/admin/api/2025-01/graphql.json`;
const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID || '';
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET || '';
if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Missing SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET env vars');
  process.exit(1);
}
const PUB_ONLINE = 'gid://shopify/Publication/195088351418';
const LOCATION = 'gid://shopify/Location/86211100858';
const LIMIT = Number(process.env.SYNC_LIMIT || 0); // 0 = all

async function token() {
  const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  const res = await fetch(`https://${DOMAIN}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  const j = await res.json();
  if (!j.access_token) throw new Error('No access token: ' + JSON.stringify(j));
  return j.access_token;
}

async function gql(access, query, variables) {
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': access, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const j = await res.json();
  if (j.errors?.length) throw new Error(JSON.stringify(j.errors));
  return j.data;
}

function loadCatalog() {
  const appPath = path.join(__dirname, '../src/App.dc.html');
  const html = fs.readFileSync(appPath, 'utf8');
  const re = /slug: '([^']+)', n: '([^']+)', style: '([^']+)'/g;
  const out = [];
  let m;
  while ((m = re.exec(html))) out.push({ slug: m[1], name: m[2], style: m[3] });
  return out;
}

async function ensureOptions(access, productGid, optionId) {
  await gql(access, `mutation($productId: ID!, $option: OptionUpdateInput!, $optionValuesToAdd: [OptionValueCreateInput!]) {
    productOptionUpdate(productId: $productId, option: $option, optionValuesToAdd: $optionValuesToAdd) {
      userErrors { message }
    }
  }`, {
    productId: productGid,
    option: { id: optionId, name: 'Tamano' },
    optionValuesToAdd: [{ name: '17x17 in' }, { name: '36x17 in' }],
  });
}

async function setInventory(access, inventoryItemIds) {
  const quantities = inventoryItemIds.map((inventoryItemId) => ({
    inventoryItemId, locationId: LOCATION, quantity: 49,
  }));
  await gql(access, `mutation($input: InventorySetQuantitiesInput!) {
    inventorySetQuantities(input: $input) { userErrors { message } }
  }`, {
    input: { name: 'available', reason: 'correction', ignoreCompareQuantity: true, quantities },
  });
}

async function syncOne(access, item) {
  const existing = await gql(access, `query($q: String!) {
    products(first: 1, query: $q) {
      nodes {
        id handle
        options { id name optionValues { name } }
        variants(first: 5) { nodes { id title sku inventoryItem { id } } }
      }
    }
  }`, { q: `handle:${item.slug}` });
  let productGid = existing.products.nodes[0]?.id;
  let variants = existing.products.nodes[0]?.variants?.nodes || [];
  let options = existing.products.nodes[0]?.options || [];

  if (!productGid) {
    const created = await gql(access, `mutation($product: ProductCreateInput!) {
      productCreate(product: $product) {
        product { id handle options { id name optionValues { name } } variants(first: 5) { nodes { id title inventoryItem { id } } } }
        userErrors { message }
      }
    }`, {
      product: {
        title: item.name,
        handle: item.slug,
        vendor: 'MexPads',
        productType: 'Mousepad',
        status: 'ACTIVE',
        tags: [item.style, 'catalog'],
        descriptionHtml: `<p>${item.name} — estilo ${item.style}. Tela multispandex 3 mm, borde cosido.</p>`,
        productOptions: [{ name: 'Tamano', values: [{ name: '12x12 in' }, { name: '17x17 in' }, { name: '36x17 in' }] }],
      },
    });
    if (created.productCreate.userErrors?.length) {
      throw new Error(created.productCreate.userErrors.map((e) => e.message).join('; '));
    }
    productGid = created.productCreate.product.id;
    options = created.productCreate.product.options;
    variants = created.productCreate.product.variants.nodes;
  }

  const opt = options[0];
  if (opt && (opt.optionValues || []).length < 3) await ensureOptions(access, productGid, opt.id);

  const have = new Set(variants.map((v) => v.title));
  const needed = [
    { title: '12x12 in', price: '249.00', sku: `${item.slug}-M` },
    { title: '17x17 in', price: '349.00', sku: `${item.slug}-L` },
    { title: '36x17 in', price: '499.00', sku: `${item.slug}-XL` },
  ];
  const missing = needed.filter((n) => !have.has(n.title));
  if (missing.length) {
    const bulk = await gql(access, `mutation($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkCreate(productId: $productId, variants: $variants) {
        productVariants { id title price sku inventoryItem { id } }
        userErrors { message }
      }
    }`, {
      productId: productGid,
      variants: missing.map((n) => ({
        price: n.price,
        optionValues: [{ optionName: 'Tamano', name: n.title }],
        inventoryItem: { tracked: true, sku: n.sku },
      })),
    });
    if (bulk.productVariantsBulkCreate.userErrors?.length) {
      console.warn('bulk warn', item.slug, bulk.productVariantsBulkCreate.userErrors);
    }
  }

  // refresh + price update
  const fresh = await gql(access, `query($id: ID!) {
    product(id: $id) { variants(first: 5) { nodes { id title sku inventoryItem { id } } } }
  }`, { id: productGid });
  variants = fresh.product.variants.nodes;

  const priceByTitle = { '12x12 in': '249.00', '17x17 in': '349.00', '36x17 in': '499.00' };
  const updates = variants.filter((v) => priceByTitle[v.title]).map((v) => ({
    id: v.id,
    price: priceByTitle[v.title],
  }));
  if (updates.length) {
    await gql(access, `mutation($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants) { userErrors { message } }
    }`, { productId: productGid, variants: updates });
  }

  await gql(access, `mutation($id: ID!, $input: [PublicationInput!]!) {
    publishablePublish(id: $id, input: $input) { userErrors { message } }
  }`, { id: productGid, input: [{ publicationId: PUB_ONLINE }] });

  await setInventory(access, variants.map((v) => v.inventoryItem.id));

  const map = { slug: item.slug, productId: productGid };
  for (const v of variants) {
    if (v.title === '12x12 in') map.M = v.id;
    if (v.title === '17x17 in') map.L = v.id;
    if (v.title === '36x17 in') map.XL = v.id;
  }
  return map;
}

async function main() {
  const access = await token();
  let catalog = loadCatalog();
  if (LIMIT > 0) catalog = catalog.slice(0, LIMIT);
  console.log('Syncing', catalog.length, 'products…');
  const maps = {
    shop: DOMAIN,
    custom: {
      productId: 'gid://shopify/Product/8470180397242',
      handle: 'personalizado',
      M: 'gid://shopify/ProductVariant/46252401033402',
      L: 'gid://shopify/ProductVariant/46252401131706',
      XL: 'gid://shopify/ProductVariant/46252401164474',
    },
    products: {},
  };
  for (const item of catalog) {
    try {
      const m = await syncOne(access, item);
      maps.products[item.slug] = m;
      console.log('OK', item.slug);
    } catch (e) {
      console.error('FAIL', item.slug, e.message);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  const out = path.join(__dirname, 'variant-map.json');
  fs.writeFileSync(out, JSON.stringify(maps, null, 2));
  console.log('Wrote', out);
}

main().catch((e) => { console.error(e); process.exit(1); });
