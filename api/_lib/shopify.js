/**
 * Acceso a la Admin API de Shopify desde las funciones serverless.
 * Nada de esto llega al navegador: el token vive sólo aquí.
 */

const API_VERSION = process.env.SHOPIFY_API_VERSION || '2025-01';

export function shopDomain() {
  return process.env.SHOPIFY_SHOP_DOMAIN || 'mexpads.myshopify.com';
}

let cachedToken = null;

/**
 * Token de admin. Dos caminos:
 *  - SHOPIFY_ADMIN_TOKEN (token de app personalizada, shpat_…) → se usa tal cual.
 *  - SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET → client_credentials, se cachea.
 */
export async function adminToken() {
  const direct = process.env.SHOPIFY_ADMIN_TOKEN;
  if (direct) return direct;

  const id = process.env.SHOPIFY_CLIENT_ID;
  const secret = process.env.SHOPIFY_CLIENT_SECRET;
  if (!id || !secret) {
    throw new Error('Faltan credenciales de Shopify (SHOPIFY_ADMIN_TOKEN o SHOPIFY_CLIENT_ID/SECRET)');
  }

  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.token;

  const basic = Buffer.from(`${id}:${secret}`).toString('base64');
  const res = await fetch(`https://${shopDomain()}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  const json = await res.json().catch(() => ({}));
  if (!json.access_token) {
    throw new Error(`No se pudo obtener el token de Shopify (${res.status})`);
  }
  cachedToken = {
    token: json.access_token,
    expiresAt: Date.now() + (Number(json.expires_in || 3600) * 1000),
  };
  return cachedToken.token;
}

export async function adminGql(query, variables) {
  const token = await adminToken();
  const res = await fetch(`https://${shopDomain()}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json().catch(() => ({}));
  if (json.errors?.length) {
    throw new Error('Shopify: ' + json.errors.map((e) => e.message).join('; '));
  }
  if (!res.ok) throw new Error(`Shopify HTTP ${res.status}`);
  return json.data;
}

function firstUserError(payload) {
  const errs = payload?.userErrors || [];
  return errs.length ? errs.map((e) => e.message).join('; ') : null;
}

/**
 * Pide un destino de subida directa. El navegador sube el archivo AHÍ, no a
 * nuestra función: así no nos pega el límite de 4.5 MB de cuerpo de petición y
 * el original llega íntegro por grande que sea.
 */
export async function createStagedUpload({ filename, mimeType, fileSize }) {
  const data = await adminGql(
    `mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
      stagedUploadsCreate(input: $input) {
        stagedTargets { url resourceUrl parameters { name value } }
        userErrors { field message }
      }
    }`,
    {
      input: [{
        filename,
        mimeType,
        httpMethod: 'POST',
        resource: 'FILE',
        fileSize: String(fileSize),
      }],
    }
  );
  const err = firstUserError(data.stagedUploadsCreate);
  if (err) throw new Error(err);
  const target = data.stagedUploadsCreate?.stagedTargets?.[0];
  if (!target) throw new Error('Shopify no devolvió destino de subida');
  return target;
}

/** Registra en Shopify Files algo que ya se subió al destino temporal. */
export async function fileCreate({ resourceUrl, mimeType, alt, filename }) {
  const data = await adminGql(
    `mutation fileCreate($files: [FileCreateInput!]!) {
      fileCreate(files: $files) {
        files {
          id
          fileStatus
          alt
          ... on MediaImage { image { url width height } }
          ... on GenericFile { url }
        }
        userErrors { field message }
      }
    }`,
    {
      files: [{
        originalSource: resourceUrl,
        contentType: String(mimeType || '').startsWith('image/') ? 'IMAGE' : 'FILE',
        alt: alt || filename || 'MexPads',
        filename,
      }],
    }
  );
  const err = firstUserError(data.fileCreate);
  if (err) throw new Error(err);
  const file = data.fileCreate?.files?.[0];
  if (!file) throw new Error('Shopify no registró el archivo');
  return file;
}

/**
 * Shopify procesa los archivos en segundo plano; la URL del CDN sólo existe
 * cuando el estado pasa a READY. Sin esto, el render leería un 404.
 */
export async function waitForFile(id, { timeoutMs = 45_000, intervalMs = 1200 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const data = await adminGql(
      `query fileStatus($id: ID!) {
        node(id: $id) {
          ... on MediaImage { id fileStatus fileErrors { message } image { url width height } }
          ... on GenericFile { id fileStatus fileErrors { message } url }
        }
      }`,
      { id }
    );
    last = data?.node || null;
    const status = last?.fileStatus;
    if (status === 'READY') {
      return {
        id: last.id,
        url: last.image?.url || last.url || null,
        width: last.image?.width || null,
        height: last.image?.height || null,
      };
    }
    if (status === 'FAILED') {
      const msg = last?.fileErrors?.map((e) => e.message).join('; ') || 'desconocido';
      throw new Error('Shopify no pudo procesar el archivo: ' + msg);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('Tiempo agotado esperando a que Shopify procese el archivo');
}

/** Sube un Buffer completo (staged + POST + fileCreate + espera). */
export async function uploadBuffer({ buffer, filename, mimeType, alt }) {
  const target = await createStagedUpload({ filename, mimeType, fileSize: buffer.length });

  const form = new FormData();
  for (const p of target.parameters) form.append(p.name, p.value);
  form.append('file', new Blob([buffer], { type: mimeType }), filename);

  const up = await fetch(target.url, { method: 'POST', body: form });
  if (!up.ok && up.status !== 201 && up.status !== 204) {
    const body = await up.text().catch(() => '');
    throw new Error(`Subida al destino temporal falló (${up.status}) ${body.slice(0, 200)}`);
  }

  const file = await fileCreate({ resourceUrl: target.resourceUrl, mimeType, alt, filename });
  const ready = await waitForFile(file.id);
  return { id: ready.id, url: ready.url, width: ready.width, height: ready.height };
}

/** Deja constancia del paquete de impresión en el pedido, visible en el admin. */
export async function tagOrderWithPrintPackage(orderGid, payload) {
  return adminGql(
    `mutation setPrintPackage($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields { id key namespace }
        userErrors { field message }
      }
    }`,
    {
      metafields: [{
        ownerId: orderGid,
        namespace: 'mexpads',
        key: 'print_package',
        type: 'json',
        value: JSON.stringify(payload),
      }],
    }
  );
}
