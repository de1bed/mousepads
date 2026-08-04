# MexPads — backend de impresión

Cómo llega un diseño del cliente a tu prensa, y qué hay que configurar para que
funcione.

---

## El problema que resuelve

Antes, cuando alguien subía su diseño:

1. `cart.js` intentaba `POST /api/shopify/upload`.
2. Esa ruta **sólo existía en el servidor local** (`checkout-server.mjs`). En
   mexpads.com no había ninguna función: la petición devolvía el HTML del sitio,
   `uploadDesign` regresaba `null` y seguía de largo **sin avisar**.
3. El pedido llegaba a Shopify con la línea `Recorte: x:50 y:50 z:1` y **ningún
   archivo**. El diseño del cliente se quedaba en su navegador y se perdía.

Ahora el archivo se sube en cuanto el cliente lo elige, y al confirmarse el
pedido se genera el archivo listo para sublimar con el encuadre exacto.

---

## El recorrido completo

```
NAVEGADOR                        FUNCIONES (Vercel)              SHOPIFY
────────────────────────────────────────────────────────────────────────────
elige archivo
    │
    ├──── POST /api/design/stage ─────────►
    │                              pide destino temporal ────────►
    │     ◄──── url + parámetros ──────────────────────────────────
    │
    ├──── POST directo del archivo ───────────────────────────────►
    │     (no pasa por nuestra función: sin el tope de 4.5 MB)
    │
    ├──── POST /api/design/finalize ──────►
    │                              fileCreate + espera READY ─────►
    │     ◄──── originalUrl, ancho, alto, ficha ───────────────────
    │
    │  ← aquí ya se le avisa "tu imagen da 96 DPI" ANTES de pagar
    │
    └──── checkout ────────────────────────────────────────────────►
                                                          pedido creado
                                                                │
          ◄───── webhook orders/create ──────────────────────────┘
                 por cada línea:
                   descarga el original
                   recorta EXACTO lo que el cliente encuadró
                   escala al tamaño físico real (300 DPI)
                   agrega 3 mm de sangrado en espejo
                   quema el monograma MP donde lo pidió
                   sube el archivo a Shopify Files
                   te manda la hoja de producción por correo
```

---

## La geometría (lo que no se puede equivocar)

Todo diseño vive sobre un **maestro de 36 × 17 in**. Cada talla recorta una
ventana de pulgadas reales sobre ese maestro:

| Talla | Pulgadas | Ventana del maestro | Lienzo a 300 DPI (con sangrado) |
|-------|----------|---------------------|----------------------------------|
| M     | 12 × 12  | 33 % ancho × 71 % alto | 3 670 × 3 670 px |
| L     | 17 × 17  | 47 % ancho × 100 % alto | 5 170 × 5 170 px |
| XL    | 36 × 17  | 100 % × 100 %          | 10 870 × 5 170 px |

El `zoom` (1× a 3×) achica la ventana: acerca el arte y se imprime más detalle
de menos superficie. `posX`/`posY` (0–100) la mueven.

Esta cuenta está en **tres lugares y tiene que dar igual en los tres**:

- `techpad/src/App.dc.html` → `_crop()` — lo que el cliente ve en pantalla.
- `techpad/shopify/cart.js` → `respec()` — el aviso de resolución.
- `api/_lib/print.js` → `printSpec()` — el archivo que se imprime.

Si tocas una, toca las tres y corre las pruebas:

```bash
node --test api/_lib/print.test.js
```

### Resolución efectiva

`effectiveDpi = píxeles reales del recorte ÷ pulgadas impresas`.

Debajo de **150 DPI** el pedido se marca `lowRes` y eso se ve en tres lados:
en el configurador antes de pagar, en el carrito, y resaltado en tu correo.
No se bloquea la compra — se avisa.

---

## Qué hay que configurar

### 1. Variables de entorno

Copia `.env.example` y llena todo en **Vercel → Settings → Environment
Variables**. Lo mínimo para que funcione:

| Variable | Para qué | ¿Obligatoria? |
|----------|----------|---------------|
| `SHOPIFY_ADMIN_TOKEN` | subir y leer archivos, leer pedidos | **sí** |
| `SHOPIFY_WEBHOOK_SECRET` | validar que el webhook viene de Shopify | **sí** |
| `RESEND_API_KEY` | mandar el correo | no |
| `PRINT_EMAIL_TO` | a dónde llega el correo | no |
| `ADMIN_API_KEY` | rehacer un pedido a mano | no |

Con las dos obligatorias basta: los enlaces al archivo de impresión se escriben
en la **nota del pedido**, que se ve al abrirlo en el admin de Shopify. El correo
sólo ahorra el clic de abrir el pedido.

Comprueba con `https://mexpads.com/api/health` — te dice qué falta.

### 2. App personalizada en Shopify

Admin → Configuración → Apps y canales de venta → **Desarrollar apps** →
Crear app. Permisos de Admin API:

- `write_files`, `read_files` — subir el original y el archivo de impresión
- `read_orders`, `write_orders` — leer el pedido y colgarle el metafield
- `write_themes` — sólo si vas a subir el tema puente (abajo)

Instala la app y copia el **Admin API access token** (`shpat_…`).

### 3. Webhook

Admin → Configuración → **Notificaciones** → Webhooks → Crear webhook:

- Evento: **Creación de pedido**
- Formato: **JSON**
- URL: `https://mexpads.com/api/webhooks/orders-create`

Al final de esa página Shopify muestra la clave secreta → `SHOPIFY_WEBHOOK_SECRET`.

### 4. Memoria de la función (si los XL fallan)

Un 36 × 17 a 300 DPI son ~165 MB en memoria. Si ves errores de memoria en los
logs, súbele en Vercel → Settings → Functions → Memory. Con 1 GB alcanza para
casi todo; 2 GB va sobrado.

---

## El checkout

### El logo que manda a la tienda vacía

El nombre en el checkout apunta al dominio principal de la tienda, que hoy es
`mexpads.myshopify.com` — el storefront de Shopify que no usas, con el tema
Horizon genérico.

**No se puede arreglar poniendo mexpads.com como dominio principal**: ese
dominio ya apunta a Vercel, y no puede apuntar a Shopify al mismo tiempo.

La salida es el **tema puente**: un tema cuya única función es reenviar todo a
mexpads.com conservando la ruta.

```bash
node techpad/shopify/deploy-redirect-theme.mjs            # sube sin publicar
# revisa la vista previa en el admin, y si te late:
node techpad/shopify/deploy-redirect-theme.mjs --publish
```

Después de publicarlo, quien le pique al nombre en el checkout cae en
mexpads.com al instante, no en la tienda vacía.

> Publicarlo reemplaza a Horizon como tema activo. Horizon no se borra: queda
> en la lista de temas y puedes volver a él cuando quieras.

### El logo en vez de las letras genéricas

Esto **no se puede hacer por API**: `checkoutBrandingUpsert` es exclusivo de
Shopify Plus y la tienda está en Basic. Se hace a mano, una sola vez:

Admin → Configuración → **Pagar** (Checkout) → *Personalizar* →
sección **Encabezado** → subir logo → usa
`techpad/assets/brand/wordmark-mexpads.png`.

---

## Cuando algo sale mal

### Rehacer el paquete de un pedido

```bash
curl -X POST https://mexpads.com/api/print/build \
  -H "Content-Type: application/json" \
  -H "x-mexpads-key: $ADMIN_API_KEY" \
  -d '{"order":"1042"}'
```

Vuelve a generar los archivos y te reenvía el correo. Sirve si el webhook falló,
si cambiaste el DPI, o si borraste un archivo por error.

### Un pedido con muchos diseños

La función tiene 60 segundos. Si un pedido trae tantos diseños que no alcanza,
las líneas que faltaron llegan marcadas en el correo y se rehacen con el comando
de arriba. No se pierde nada.

### El correo no llega

`RESEND_API_KEY` vacía → no se manda correo, y el envío queda anotado en los
logs de la función en Vercel (búscalo por `[mail]`). No se pierde nada: los
enlaces están en la **nota del pedido**, y además en Shopify Files y en el
metafield `mexpads.print_package` del pedido.

---

## Probar en local

```bash
npm install
node --env-file=.env techpad/server/checkout-server.mjs
# http://127.0.0.1:8123 — sirve el sitio y monta las mismas funciones de /api
```

El servidor local importa los handlers de `/api` directamente, así que lo que
pruebas ahí es exactamente lo que corre en producción.
