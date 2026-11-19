#!/usr/bin/env node
// Evaluación del reconocimiento por foto: ANTES (lógica anterior: huella del catálogo +
// color) vs DESPUÉS (con las referencias precalculadas de models/catalog-refs-v1.*).
// Las fotos de prueba se fabrican con eval-transforms.js, transformaciones DISTINTAS de las
// del entrenamiento. Además, "foto distinta": para productos con varias fotos, se busca con
// una foto secundaria SIN sus propias referencias (la pieza real, otra toma).
//
//   node eval-catalog-refs.mjs --site <copia local del sitio> [--tfjs tf.min.js] [--refs ../models/catalog-refs-v1]
//          [--cache q.json] (guarda/reusa las huellas de las fotos de prueba) [--panel] (cifras
//          oficiales con las funciones reales del panel: prepareCatalogEmbeddings + rankCatalog)
import fs from 'node:fs';
import path from 'node:path';
import { ADMIN_DIR, openRecognitionPage, productUrls } from './recog-page.mjs';

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf('--' + name); return i >= 0 ? (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true) : def; };
const siteDir = path.resolve(opt('site', ''));
const REFS = path.resolve(opt('refs', path.join(ADMIN_DIR, 'models', 'catalog-refs-v1')));
const CACHE = opt('cache', null);
const SAMPLES = opt('samples', null); // carpeta donde guardar algunas fotos de prueba (jpg)
const catalog = JSON.parse(fs.readFileSync(path.join(siteDir, 'data', 'products.json'), 'utf8'));
const avail = catalog.products.filter(p => p && p.available !== false && productUrls(p).length);
const extraJs = fs.readFileSync(path.join(ADMIN_DIR, 'tools', 'eval-transforms.js'), 'utf8');
const EMB_W = 0.85, COLOR_W = 0.15;

let rp = null;
const page = async () => (rp ||= await openRecognitionPage({ siteDir, tfjsFile: opt('tfjs', null), extraJs }));

// ── Fase 1: huellas de las fotos de prueba y del catálogo (como el panel anterior) ──
let data = CACHE && fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE, 'utf8')) : null;
if (!data) {
  const { page: pg, localUrl } = await page();
  data = { catalog: {}, queries: [] };
  const t0 = Date.now();
  for (const [i, p] of avail.entries()) {
    const urls = productUrls(p);
    const r = await pg.evaluate(async ([main, extras, id, keep]) => {
      const eng = await loadRecognitionModel();
      const img = await loadImg(main, false);
      const cat = { emb: Array.from(embedCanvas(eng, squareCrop(img, 1, 224))), color: Array.from(colorDescriptor(img)) };
      const qs = [];
      for (const mode of ['A', 'B']) {
        const dataUrl = makeTestPhoto(img, strHash('eval|' + id + '|' + mode), mode);
        const q = await embedQueryPhoto(dataUrl);
        qs.push({ kind: mode, emb: Array.from(q.emb), color: Array.from(q.color), sample: keep ? dataUrl : null });
      }
      for (const [k, u] of extras.entries()) { // otra foto del mismo producto
        const eimg = await loadImg(u.local, false);
        const raw = await embedQueryPhoto(u.local);
        qs.push({ kind: 'otra-foto', url: u.url, emb: Array.from(raw.emb), color: Array.from(raw.color) });
        const t = await embedQueryPhoto(makeTestPhoto(eimg, strHash('eval|' + id + '|X' + k), 'A'));
        qs.push({ kind: 'otra-foto+A', url: u.url, emb: Array.from(t.emb), color: Array.from(t.color) });
      }
      return { cat, qs };
    }, [localUrl(urls[0]), urls.slice(1).map(u => ({ url: u, local: localUrl(u) })), String(p.id), i < 6]);
    data.catalog[String(p.id)] = r.cat;
    for (const q of r.qs) {
      if (q.sample && SAMPLES) { fs.mkdirSync(SAMPLES, { recursive: true }); fs.writeFileSync(path.join(SAMPLES, `q-${p.id}-${q.kind}.jpg`), Buffer.from(q.sample.split(',')[1], 'base64')); }
      delete q.sample;
      data.queries.push({ id: String(p.id), category: p.category, ...q });
    }
    process.stdout.write(`\r  fotos de prueba: ${i + 1}/${avail.length} productos · ${((Date.now() - t0) / 1000).toFixed(0)} s  `);
  }
  console.log('');
  if (CACHE) fs.writeFileSync(CACHE, JSON.stringify(data));
}

// ── Fase 2: puntajes con distintas estrategias (réplica exacta de la fórmula del panel) ──
const l2 = v => { let s = 0; for (const x of v) s += x * x; const n = Math.sqrt(s) || 1; return Float32Array.from(v, x => x / n); };
const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
const colorSim = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += Math.min(a[i], b[i]); return s; };
const idx = JSON.parse(fs.readFileSync(REFS + '.json', 'utf8'));
const bin = new Int8Array(fs.readFileSync(REFS + '.bin').buffer.slice(0));
const vec = k => l2(bin.subarray(k * idx.dim, (k + 1) * idx.dim));
const refs = {}; // id → [{url, base, aug:[...]}]
for (const [id, list] of Object.entries(idx.products)) refs[id] = list.map(e => ({ url: e.url, base: vec(e.offset), aug: Array.from({ length: e.n }, (_, k) => vec(e.offset + 1 + k)) }));
const cat = Object.fromEntries(Object.entries(data.catalog).map(([id, c]) => [id, { emb: Float32Array.from(c.emb), color: c.color }]));
const queries = data.queries.map(q => ({ ...q, emb: Float32Array.from(q.emb) }));

// sims de una consulta contra un producto: base (catálogo) + refs aumentadas (+ base de las otras fotos)
function simsFor(q, id, { nAug = 99, exclude = null, int8Base = false } = {}) {
  const main = cat[id], r = (refs[id] || []).filter(e => e.url !== exclude);
  const mainUrl = productUrls(avail.find(p => String(p.id) === id))[0];
  const mainRef = r.find(e => e.url === mainUrl);
  const base = dot(q.emb, int8Base && mainRef ? mainRef.base : main.emb);
  const aug = [];
  for (const e of r) {
    if (e.url !== mainUrl) aug.push(dot(q.emb, e.base));
    for (const v of e.aug.slice(0, nAug)) aug.push(dot(q.emb, v));
  }
  return { base, aug: aug.sort((a, b) => b - a), color: colorSim(q.color, main.color) };
}
const AUG_MARGIN = 0.03; // = AUG_MARGIN de index.html
const STRATS = {
  'antes (catálogo)': s => s.base,
  'max(catálogo, refs)': s => Math.max(s.base, ...s.aug),
  'PANEL max(catálogo, refs − margen)': s => Math.max(s.base, (s.aug[0] ?? -1) - AUG_MARGIN),
  'media top-2 de todo': s => { const a = [s.base, ...s.aug].sort((x, y) => y - x); return a.length > 1 ? (a[0] + a[1]) / 2 : a[0]; },
  'mezcla 0,5 catálogo + 0,5 max': s => 0.5 * s.base + 0.5 * Math.max(s.base, ...s.aug),
};
function evaluate(qs, strat, o = {}, useCat = false) {
  let h1 = 0, h5 = 0, mrr = 0;
  for (const q of qs) {
    const ex = o.excludeQueryUrl ? q.url : null;
    const scored = avail.filter(p => !useCat || p.category === q.category).map(p => {
      const s = simsFor(q, String(p.id), { ...o, exclude: ex });
      return { id: String(p.id), score: EMB_W * strat(s) + COLOR_W * s.color };
    }).sort((a, b) => b.score - a.score);
    const rank = scored.findIndex(x => x.id === q.id) + 1;
    if (rank === 1) h1++; if (rank && rank <= 5) h5++; if (rank) mrr += 1 / rank;
  }
  return { n: qs.length, h1, h5, mrr: mrr / qs.length };
}
const pct = (a, n) => `${a}/${n} (${(100 * a / n).toFixed(1)} %)`;
const groups = {
  'A pieza chica/descentrada': queries.filter(q => q.kind === 'A'),
  'B recorte parcial + dedo': queries.filter(q => q.kind === 'B'),
  'A+B (catálogo)': queries.filter(q => q.kind === 'A' || q.kind === 'B'),
  'otra foto (sin sus refs)': queries.filter(q => q.kind === 'otra-foto'),
  'otra foto + A (sin sus refs)': queries.filter(q => q.kind === 'otra-foto+A'),
};
console.log(`\nRefs: ${idx.vectors} vectores, ${idx.perImage.aug} variantes/foto, generado ${idx.generated}`);
const variants = { 'antes (catálogo)': [[{}, ''], [{ int8Base: true }, ' [base int8]']], 'PANEL max(catálogo, refs − margen)': [[{}, ''], [{ nAug: 4 }, ' [solo 4 var.]'], [{ nAug: 8 }, ' [solo 8 var.]']] };
for (const [gname, qs] of Object.entries(groups)) {
  if (!qs.length) continue;
  console.log(`\n== ${gname}: ${qs.length} consultas ==`);
  for (const [sname, fn] of Object.entries(STRATS)) for (const [o, tag] of (variants[sname] || [[{}, '']])) {
    const oo = { ...o, excludeQueryUrl: gname.startsWith('otra') };
    const a = evaluate(qs, fn, oo, false), b = evaluate(qs, fn, oo, true);
    console.log(`  ${(sname + tag).padEnd(46)} hit@1 ${pct(a.h1, a.n).padEnd(16)} hit@5 ${pct(a.h5, a.n).padEnd(16)} MRR ${a.mrr.toFixed(3)} | con categoría: hit@1 ${pct(b.h1, b.n).padEnd(16)} hit@5 ${pct(b.h5, b.n)}`);
  }
}
// ── Fase 3 (--panel): cifras oficiales con las funciones REALES del panel ──
// prepareCatalogEmbeddings (que carga models/catalog-refs-v1.* vía loadStaticRefs) + rankCatalog.
// ANTES = sin referencias precalculadas (loadStaticRefs → null: exactamente la lógica anterior).
// Para "otra foto", esa foto se quita de images[] del producto: el panel debe ignorar sus
// referencias (es el mismo mecanismo que descarta referencias de una foto cambiada).
if (opt('panel', false)) {
  const { page: pg } = await page();
  if (REFS !== path.join(ADMIN_DIR, 'models', 'catalog-refs-v1')) throw new Error('--panel usa el archivo que carga el panel: models/catalog-refs-v1.* (no pasar --refs)');
  const run = (mode, qs, prods) => pg.evaluate(async ([mode, qs, prods]) => {
    _staticRefsPromise = mode === 'antes' ? Promise.resolve(null) : null;
    _embMem.clear();
    const db = await embDb(); // caché vacía = primera vez en un navegador nuevo
    await new Promise(r => { const tx = db.transaction(EMB_STORE, 'readwrite'); tx.objectStore(EMB_STORE).clear(); tx.oncomplete = tx.onerror = () => r(); });
    const t0 = performance.now();
    let res = await prepareCatalogEmbeddings(prods);
    const prepMs = performance.now() - t0, first = { trained: res.trained, computed: res.computed };
    const t1 = performance.now(); await prepareCatalogEmbeddings(prods); const prep2Ms = performance.now() - t1;
    const out = [];
    for (const q of qs) {
      if (q.hideUrl) res = await prepareCatalogEmbeddings(prods.map(p => String(p.id) === q.id ? { ...p, images: (p.images || []).filter(u => u !== q.hideUrl) } : p));
      const qq = { emb: Float32Array.from(q.emb), color: Float32Array.from(q.color) };
      const rk = c => rankCatalog(qq, res.items, {}, c, 1e9).findIndex(r => String(r.p.id) === q.id) + 1;
      out.push([rk('Todas'), rk(q.category)]);
      if (q.hideUrl) res = await prepareCatalogEmbeddings(prods);
    }
    return { prepMs, prep2Ms, ...first, out };
  }, [mode, qs, prods]);
  const qs = data.queries.map(q => ({ id: q.id, category: q.category, emb: q.emb, color: q.color, kind: q.kind, hideUrl: q.kind.startsWith('otra') ? q.url : null }));
  console.log('\n== Panel real (prepareCatalogEmbeddings + rankCatalog) ==');
  const res = {};
  for (const mode of ['antes', 'después']) res[mode] = await run(mode, qs, catalog.products);
  for (const mode of ['antes', 'después']) console.log(`  ${mode}: 1ra preparación ${(res[mode].prepMs / 1000).toFixed(1)} s (fotos calculadas: ${res[mode].computed}), 2da ${(res[mode].prep2Ms / 1000).toFixed(2)} s, productos con referencias: ${res[mode].trained}`);
  for (const kinds of [['A'], ['B'], ['A', 'B'], ['otra-foto'], ['otra-foto+A']]) {
    const sel = qs.map((q, i) => [q, i]).filter(([q]) => kinds.includes(q.kind));
    if (!sel.length) continue;
    const line = mode => { const r = sel.map(([, i]) => res[mode].out[i]); const n = r.length;
      const f = j => `hit@1 ${pct(r.filter(x => x[j] === 1).length, n).padEnd(16)} hit@5 ${pct(r.filter(x => x[j] >= 1 && x[j] <= 5).length, n).padEnd(16)}`;
      return `${f(0)}| con categoría: ${f(1)}`; };
    console.log(`  [${kinds.join('+')}] n=${sel.length}`);
    for (const mode of ['antes', 'después']) console.log(`    ${mode.padEnd(8)} ${line(mode)}`);
  }
}
if (rp) await rp.close();
