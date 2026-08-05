/**
 * node --test api/_lib/print.test.js
 *
 * La geometría es lo único que no se puede equivocar: si estas cuentas se
 * mueven, cada sublimación sale corrida y no hay forma de notarlo hasta que la
 * playera... perdón, el mousepad, ya está impreso.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { masterRect, printSpec, windowFractions, monogramBox, SIZES } from './print.js';

test('el maestro recorta 36:17 centrado sobre la fuente', () => {
  // Fuente más ancha que 36:17 → sobra a los lados, alto completo.
  const wide = masterRect(4000, 1000);
  assert.equal(wide.height, 1000);
  assert.equal(Math.round(wide.width), Math.round(1000 * (36 / 17)));
  assert.ok(wide.x > 0 && wide.y === 0);

  // Fuente más alta → sobra arriba y abajo, ancho completo.
  const tall = masterRect(1000, 4000);
  assert.equal(tall.width, 1000);
  assert.equal(Math.round(tall.height), Math.round(1000 / (36 / 17)));
  assert.ok(tall.y > 0 && tall.x === 0);

  // Exactamente 36:17 → sin recorte.
  const exact = masterRect(3600, 1700);
  assert.equal(exact.x, 0);
  assert.equal(exact.y, 0);
  assert.equal(exact.width, 3600);
});

test('las fracciones de ventana coinciden con _crop del front', () => {
  // XL a zoom 1 ve el maestro completo.
  const xl = windowFractions('XL', 50, 50, 1);
  assert.equal(xl.wFrac, 1);
  assert.equal(xl.hFrac, 1);
  assert.equal(xl.x0, 0);

  // L (17x17) ve 17/36 del ancho y todo el alto.
  const l = windowFractions('L', 0, 0, 1);
  assert.ok(Math.abs(l.wFrac - 17 / 36) < 1e-9);
  assert.equal(l.hFrac, 1);
  assert.equal(l.x0, 0);

  // M (12x12) con la ventana pegada a la derecha.
  const m = windowFractions('M', 100, 100, 1);
  assert.ok(Math.abs(m.wFrac - 12 / 36) < 1e-9);
  assert.ok(Math.abs(m.hFrac - 12 / 17) < 1e-9);
  assert.ok(Math.abs(m.x0 - (1 - 12 / 36)) < 1e-9);

  // Zoom acerca: se ve menos superficie.
  const z2 = windowFractions('XL', 50, 50, 2);
  assert.equal(z2.wFrac, 0.5);
  assert.equal(z2.x0, 0.25);
});

test('zoom y posición se recortan a rangos válidos', () => {
  assert.equal(windowFractions('XL', 50, 50, 99).wFrac, 1 / 3); // zoom tope 3
  assert.equal(windowFractions('XL', 50, 50, 0.1).wFrac, 1); // zoom mínimo 1
  assert.equal(windowFractions('M', -50, 999, 1).x0, 0); // posX se limita a 0
});

test('el lienzo sale al tamaño físico con sangrado', () => {
  const spec = printSpec({ sourceW: 12000, sourceH: 5667, size: 'XL', posX: 50, posY: 50, zoom: 1 });
  assert.equal(spec.trimPx.width, 36 * 300);
  assert.equal(spec.trimPx.height, 17 * 300);
  // 3 mm a 300 DPI ≈ 35 px por lado.
  assert.equal(spec.bleedPx, Math.round((3 / 25.4) * 300));
  assert.equal(spec.canvas.width, spec.trimPx.width + spec.bleedPx * 2);
  assert.equal(spec.canvas.height, spec.trimPx.height + spec.bleedPx * 2);
});

test('cada talla pide su tamaño real en pulgadas', () => {
  for (const key of Object.keys(SIZES)) {
    const [w, h] = SIZES[key].inches;
    const spec = printSpec({ sourceW: 8000, sourceH: 8000, size: key, posX: 50, posY: 50, zoom: 1, dpi: 300 });
    assert.equal(spec.trimPx.width, w * 300);
    assert.equal(spec.trimPx.height, h * 300);
    assert.equal(spec.inches.width, w);
  }
});

test('el recorte de origen queda dentro de la imagen', () => {
  const cases = [
    [4032, 3024, 'M'], [4032, 3024, 'L'], [4032, 3024, 'XL'],
    [1080, 1920, 'M'], [6000, 2000, 'XL'], [800, 800, 'L'],
  ];
  for (const [w, h, size] of cases) {
    for (const pos of [0, 25, 50, 75, 100]) {
      for (const zoom of [1, 1.5, 3]) {
        const spec = printSpec({ sourceW: w, sourceH: h, size, posX: pos, posY: pos, zoom });
        const e = spec.extract;
        assert.ok(e.left >= 0 && e.top >= 0, `origen negativo en ${w}x${h} ${size}`);
        assert.ok(e.width >= 1 && e.height >= 1, `recorte vacío en ${w}x${h} ${size}`);
        assert.ok(e.left + e.width <= w, `se sale a la derecha en ${w}x${h} ${size} pos ${pos} z ${zoom}`);
        assert.ok(e.top + e.height <= h, `se sale abajo en ${w}x${h} ${size} pos ${pos} z ${zoom}`);
      }
    }
  }
});

test('la resolución efectiva detecta archivos chicos', () => {
  // 3600 px de ancho repartidos en 36 in = 100 DPI → hay que avisar.
  const chico = printSpec({ sourceW: 3600, sourceH: 1700, size: 'XL', posX: 50, posY: 50, zoom: 1 });
  assert.equal(chico.effectiveDpi, 100);
  assert.equal(chico.lowRes, true);

  // 10800 px de ancho = 300 DPI exactos → pasa.
  const bueno = printSpec({ sourceW: 10800, sourceH: 5100, size: 'XL', posX: 50, posY: 50, zoom: 1 });
  assert.equal(bueno.effectiveDpi, 300);
  assert.equal(bueno.lowRes, false);

  // El zoom recorta menos superficie, así que baja la resolución real.
  const zoom = printSpec({ sourceW: 10800, sourceH: 5100, size: 'XL', posX: 50, posY: 50, zoom: 2 });
  assert.equal(zoom.effectiveDpi, 150);
});

test('recommendedSource dice cuánto haría falta para llegar a 300 DPI', () => {
  const spec = printSpec({ sourceW: 2000, sourceH: 1000, size: 'M', posX: 50, posY: 50, zoom: 1 });
  const need = spec.recommendedSource;
  // Con esa fuente el recorte debe dar exactamente el corte pedido.
  const check = printSpec({ sourceW: need.width, sourceH: need.height, size: 'M', posX: 50, posY: 50, zoom: 1 });
  assert.ok(check.effectiveDpi >= 300, `esperaba >=300, dio ${check.effectiveDpi}`);
  assert.equal(check.lowRes, false);
});

test('el monograma cae dentro del área de corte', () => {
  for (const size of ['M', 'L', 'XL']) {
    const spec = printSpec({ sourceW: 12000, sourceH: 6000, size, posX: 50, posY: 50, zoom: 1 });
    for (const pos of ['bl', 'br']) {
      const box = monogramBox(spec, pos);
      const left = box.left != null ? box.left : spec.canvas.width - spec.bleedPx - box.side - box.width;
      assert.ok(left >= spec.bleedPx, `${size}/${pos}: el logo se mete en el sangrado`);
      assert.ok(left + box.width <= spec.canvas.width - spec.bleedPx, `${size}/${pos}: el logo se sale`);
      assert.ok(box.width > 0);
    }
  }
});

test('una foto vertical de celular en XL no revienta', () => {
  const spec = printSpec({ sourceW: 3024, sourceH: 4032, size: 'XL', posX: 50, posY: 0, zoom: 1 });
  assert.ok(spec.extract.width >= 1 && spec.extract.height >= 1);
  assert.equal(spec.lowRes, true); // 3024/36 = 84 DPI
  assert.equal(spec.trimPx.width, 10800);
});
