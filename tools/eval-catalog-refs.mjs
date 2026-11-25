#!/usr/bin/env node
// Evaluación del reconocimiento por foto con la huella que carga el panel (v2 si están sus
// archivos en models/, si no v1): SIN referencias precalculadas (solo la huella del catálogo +
// color) vs CON ellas (models/catalog-refs-v2.* o v1.*).
// Las fotos de prueba se fabrican con eval-transforms.js, transformaciones DISTINTAS de las
// del entrenamiento. Además, "foto distinta": para productos con varias fotos, se busca con
// una foto secundaria SIN sus propias referencias (la pieza real, otra toma).
//
//   node eval-catalog-refs.mjs --site <copia local del sitio> [--tfjs tf.min.js] [--refs ../models/catalog-refs-v2]
//          [--cache q.json] (guarda/reusa las huellas de las fotos de prueba) [--panel] (cifras
//          oficiales con las funciones reales del panel: prepareCatalogEmbeddings + rankCatalog)
//          [--multi] [--box] [--cache21 q21.json] (v2.1: varias fotos de la pieza y caja marcada a mano)
//          [--quality] (calibración del aviso de foto oscura/movida)
//          [--doubt] [--learned] (umbral del aviso de duda; fotos reales simuladas en 4 escenarios; usan --cache21)
//          [--real <carpeta> [--tune]] (fotos reales: <carpeta>/labels.json = [{file, sku}]; ver real-eval.mjs)
//          [--autofill] ("Sugerir datos desde la foto": categoría, material, precio y tono dejando afuera cada producto)
//          [--real <carpeta> --new [--dump r.json]] (piezas que no están en el catálogo: inscripción simulada y "no registrada")
import fs from 'node:fs';
import path from 'node:path';
import { ADMIN_DIR, SITE_ORIGIN, openRecognitionPage, productUrls } from './recog-page.mjs';

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf('--' + name); return i >= 0 ? (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true) : def; };
const siteDir = path.resolve(opt('site', ''));
const CACHE = opt('cache', null);
const SAMPLES = opt('samples', null); // carpeta donde guardar algunas fotos de prueba (jpg)
const catalog = JSON.parse(fs.readFileSync(path.join(siteDir, 'data', 'products.json'), 'utf8'));
const avail = catalog.products.filter(p => p && p.available !== false && productUrls(p).length);
const extraJs = fs.readFileSync(path.join(ADMIN_DIR, 'tools', 'eval-transforms.js'), 'utf8');

let rp = null;
const page = async () => (rp ||= await openRecognitionPage({ siteDir, tfjsFile: opt('tfjs', null), extraJs, backend: opt('webgl', false) ? 'webgl' : 'wasm' }));
// Versión de la huella y sus pesos (los del panel): se leen del motor que cargó la página.
const engInfo = await (await page()).page.evaluate(async () => { const e = await loadRecognitionModel(); return { kind: e.kind, ver: e.ver, cw: e.cw, margin: e.margin, refsUrl: e.refsUrl }; });
console.log(`Huella: ${engInfo.ver} (${engInfo.kind}), color ${engInfo.cw}, margen ${engInfo.margin}`);
const PANEL_REFS = path.join(ADMIN_DIR, engInfo.refsUrl.replace(/\.json$/, ''));
const REFS = path.resolve(opt('refs', PANEL_REFS));
const COLOR_W = engInfo.cw, EMB_W = 1 - COLOR_W;
// --autofill (v2.5): "✦ Sugerir datos desde la foto" dejando afuera cada producto (leave-one-out):
// se esconde el producto y se predicen categoría, material, precio y tono desde su foto principal.
if (opt('autofill', false)) {
  const { page: pg, localUrl } = await page();
  const r = await pg.evaluate(async ([prods, locals]) => {
    const eng = await loadRecognitionModel();
    const cat = await prepareCatalogEmbeddings(prods);
    const out = [];
    for (const it of cat.items) {
      const items = cat.items.filter(x => x !== it);
      const img = await loadImg(locals[String(it.p.id)], false);
      const tone = photoTone(img);
      const sug = localProductSuggestion({ emb: it.emb, color: it.color, kind: eng.kind, cw: eng.cw, margin: eng.margin }, items, { tone });
      const truthTone = /rodio|plata 925$/i.test(String(it.p.material || '')) || /platead|silver/i.test(String(it.p.name || '') + ' ' + String(it.p.name_en || '')) ? 'plateado' : 'dorado';
      out.push({ cat: it.p.category, pc: sug.category, cs: sug.catShare, mat: it.p.material || '', pm: sug.material, ms: sug.matShare, price: Number(it.p.price) || 0, pp: sug.price, tone: truthTone, pt: tone, name: templateProductText(sug).name });
    }
    return out;
  }, [catalog.products, Object.fromEntries(avail.map(p => [String(p.id), localUrl(productUrls(p)[0])]))]);
  const n = r.length, pc = (a, b) => `${a}/${b} (${(100 * a / b).toFixed(1)} %)`;
  const strong = r.filter(x => x.cs >= 0.6), mstrong = r.filter(x => x.ms >= 0.6);
  const errs = r.filter(x => x.price > 0 && x.pp).map(x => Math.abs(x.pp - x.price)).sort((a, b) => a - b);
  const mostCat = Object.entries(r.reduce((m, x) => (m[x.cat] = (m[x.cat] || 0) + 1, m), {})).sort((a, b) => b[1] - a[1])[0];
  const mostMat = Object.entries(r.reduce((m, x) => (m[x.mat] = (m[x.mat] || 0) + 1, m), {})).sort((a, b) => b[1] - a[1])[0];
  const medPrice = [...r.map(x => x.price)].sort((a, b) => a - b)[Math.floor(n / 2)];
  console.log(`\n== Sugerir datos desde la foto (dejando afuera cada producto; ${n} productos) ==`);
  console.log(`  categoría: ${pc(r.filter(x => x.pc === x.cat).length, n)} · con voto fuerte (≥ 60 %, ${strong.length}): ${pc(strong.filter(x => x.pc === x.cat).length, strong.length)} · siempre la más común ("${mostCat[0]}"): ${pc(mostCat[1], n)}`);
  console.log(`  material: ${pc(r.filter(x => x.pm === x.mat).length, n)} · con voto fuerte (${mstrong.length}): ${pc(mstrong.filter(x => x.pm === x.mat).length, mstrong.length)} · siempre el más común ("${mostMat[0]}"): ${pc(mostMat[1], n)}`);
  const base = r.filter(x => x.price > 0).map(x => Math.abs(medPrice - x.price)).sort((a, b) => a - b);
  console.log(`  precio: error mediano $${errs[Math.floor(errs.length / 2)]} · medio $${(errs.reduce((a, b) => a + b, 0) / errs.length).toFixed(1)} · dentro de ±$5: ${pc(errs.filter(e => e <= 5).length, errs.length)} | siempre la mediana del catálogo ($${medPrice}): error mediano $${base[Math.floor(base.length / 2)]}`);
  const tn = r.filter(x => x.pt);
  console.log(`  tono (dorado/plateado; verdad aproximada por material/nombre): acierta ${pc(tn.filter(x => x.pt === x.tone).length, tn.length)} · sin tono claro: ${n - tn.length}`);
  console.log('  ejemplos de nombre: ' + r.slice(0, 6).map(x => x.name).join(' · '));
  await rp.close();
  process.exit(0);
}
// --real <dir> [--tune] (v2.4): fotos reales etiquetadas (<dir>/labels.json); no corre las demás fases.
if (opt('real', false)) {
  const { runReal, runNewPieces } = await import('./real-eval.mjs');
  if (opt('new', false)) await runNewPieces({ pg: (await page()).page, catalog, dir: path.resolve(opt('real')), SITE_ORIGIN, dump: opt('dump', null) });
  else await runReal({ pg: (await page()).page, catalog, dir: path.resolve(opt('real')), tune: !!opt('tune', false) });
  await rp.close();
  process.exit(0);
}

// ── Fase 1: huellas de las fotos de prueba y del catálogo (como el panel anterior) ──
let data = CACHE && fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE, 'utf8')) : null;
if (data && data.ver !== engInfo.ver) { console.log('caché de otra versión de la huella: se recalcula'); data = null; }
if (!data) {
  const { page: pg, localUrl } = await page();
  data = { ver: engInfo.ver, catalog: {}, queries: [] };
  const t0 = Date.now();
  for (const [i, p] of avail.entries()) {
    const urls = productUrls(p);
    const r = await pg.evaluate(async ([main, extras, id, keep]) => {
      const eng = await loadRecognitionModel();
      const img = await loadImg(main, false);
      const cat = { emb: Array.from(await embedPhoto(eng, img, 'base')), color: Array.from(colorDescriptor(img)) };
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
const dot = (a, b) => { let s = 0; const n = Math.min(a.length, b.length); for (let i = 0; i < n; i++) s += a[i] * b[i]; return s; };
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
const AUG_MARGIN = engInfo.margin; // = margen del panel
const STRATS = {
  'solo catálogo': s => s.base,
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
const variants = { 'solo catálogo': [[{}, ''], [{ int8Base: true }, ' [base int8]']], 'PANEL max(catálogo, refs − margen)': [[{}, ''], [{ nAug: 4 }, ' [solo 4 var.]'], [{ nAug: 8 }, ' [solo 8 var.]']] };
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
// prepareCatalogEmbeddings (que carga las referencias precalculadas vía loadStaticRefs) + rankCatalog.
// "sin refs" = sin referencias precalculadas (loadStaticRefs → null).
// Para "otra foto", esa foto se quita de images[] del producto: el panel debe ignorar sus
// referencias (es el mismo mecanismo que descarta referencias de una foto cambiada).
if (opt('panel', false)) {
  const { page: pg } = await page();
  if (REFS !== PANEL_REFS) throw new Error('--panel usa el archivo que carga el panel: ' + engInfo.refsUrl + ' (no pasar --refs)');
  const run = (mode, qs, prods) => pg.evaluate(async ([mode, qs, prods]) => {
    const eng = await loadRecognitionModel();
    _staticRefsPromise = mode === 'sin refs' ? Promise.resolve(null) : null; _staticRefsVer = eng.ver;
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
      const qq = { emb: Float32Array.from(q.emb), color: Float32Array.from(q.color), kind: eng.kind, cw: eng.cw, margin: eng.margin };
      const rk = c => rankCatalog(qq, res.items, {}, c, 1e9).findIndex(r => String(r.p.id) === q.id) + 1;
      out.push([rk('Todas'), rk(q.category)]);
      if (q.hideUrl) res = await prepareCatalogEmbeddings(prods);
    }
    return { prepMs, prep2Ms, ...first, out };
  }, [mode, qs, prods]);
  const qs = data.queries.map(q => ({ id: q.id, category: q.category, emb: q.emb, color: q.color, kind: q.kind, hideUrl: q.kind.startsWith('otra') ? q.url : null }));
  console.log('\n== Panel real (prepareCatalogEmbeddings + rankCatalog) ==');
  const res = {};
  for (const mode of ['sin refs', 'con refs']) res[mode] = await run(mode, qs, catalog.products);
  for (const mode of ['sin refs', 'con refs']) console.log(`  ${mode}: 1ra preparación ${(res[mode].prepMs / 1000).toFixed(1)} s (fotos calculadas: ${res[mode].computed}), 2da ${(res[mode].prep2Ms / 1000).toFixed(2)} s, productos con referencias: ${res[mode].trained}`);
  for (const kinds of [['A'], ['B'], ['A', 'B'], ['otra-foto'], ['otra-foto+A']]) {
    const sel = qs.map((q, i) => [q, i]).filter(([q]) => kinds.includes(q.kind));
    if (!sel.length) continue;
    const line = mode => { const r = sel.map(([, i]) => res[mode].out[i]); const n = r.length;
      const f = j => `hit@1 ${pct(r.filter(x => x[j] === 1).length, n).padEnd(16)} hit@5 ${pct(r.filter(x => x[j] >= 1 && x[j] <= 5).length, n).padEnd(16)}`;
      return `${f(0)}| con categoría: ${f(1)}`; };
    console.log(`  [${kinds.join('+')}] n=${sel.length}`);
    for (const mode of ['sin refs', 'con refs']) console.log(`    ${mode.padEnd(8)} ${line(mode)}`);
  }
}
// ── Fase 4 (--multi / --box, v2.1): varias fotos de la misma pieza y "Marca la joya" ──
// Mismas mitades que el ajuste: producto en la mitad "ajuste" si strHash(id) es par, si no "prueba".
// Por producto: 4 fotos de prueba de cada modo (A, B; semillas 0–3) y, si tiene otra foto, esa
// foto tal cual + 2 versiones "A" (sin sus referencias). --multi combina 2 o 3 fotos de la misma
// pieza con rankCatalogMulti; --box usa la caja exacta de la pieza en la foto de prueba (la que
// marcaría a mano) en vez de la automática. Todo con las funciones reales del panel.
if (opt('multi', false) || opt('box', false) || opt('doubt', false) || opt('learned', false)) {
  const { page: pg, localUrl } = await page();
  const C21 = opt('cache21', null);
  let d21 = C21 && fs.existsSync(C21) ? JSON.parse(fs.readFileSync(C21, 'utf8')) : null;
  if (d21 && (d21.ver !== engInfo.ver || !d21.q.some(q => q.embRef))) d21 = null; // v2.3: hace falta embRef
  if (!d21) {
    d21 = { ver: engInfo.ver, q: [] };
    const t0 = Date.now();
    for (const [i, p] of avail.entries()) {
      const urls = productUrls(p);
      const r = await pg.evaluate(async ([main, extras, id, wantBox]) => {
        const img = await loadImg(main, false), out = [], E = q => Array.from(q.emb.subarray(0, 512));
        for (const mode of ['A', 'B']) for (let s = 0; s < 4; s++) {
          const info = {}, du = makeTestPhoto(img, strHash('eval|' + id + '|' + mode + (s ? '|' + s : '')), mode, info);
          const q = await embedQueryPhoto(du), rec = { kind: mode, k: s, emb: E(q), embRef: E({ emb: q.embRef || q.emb }), color: Array.from(q.color) };
          if (wantBox) rec.embBox = E(await embedQueryPhoto(du, { box: info.box }));
          out.push(rec);
        }
        for (const [k, u] of extras.entries()) {
          const eimg = await loadImg(u.local, false);
          const q0 = await embedQueryPhoto(u.local);
          out.push({ kind: 'otra-foto', k: 0, url: u.url, emb: E(q0), color: Array.from(q0.color) });
          for (let s = 0; s < 2; s++) { const q = await embedQueryPhoto(makeTestPhoto(eimg, strHash('eval|' + id + '|X' + k + (s ? '|' + s : '')), 'A')); out.push({ kind: 'otra-foto+A', k: s, url: u.url, emb: E(q), color: Array.from(q.color) }); }
        }
        return out;
      }, [localUrl(urls[0]), urls.slice(1).map(u => ({ url: u, local: localUrl(u) })), String(p.id), !!opt('box', false)]);
      for (const q of r) d21.q.push({ id: String(p.id), category: p.category, ...q });
      process.stdout.write(`\r  fase 4: ${i + 1}/${avail.length} productos · ${((Date.now() - t0) / 1000).toFixed(0)} s  `);
    }
    console.log('');
    if (C21) fs.writeFileSync(C21, JSON.stringify(d21));
  }
  const res = await pg.evaluate(async ([qs, prods, wantMulti, wantBox, wantDoubt, wantProto]) => {
    const eng = await loadRecognitionModel();
    _staticRefsPromise = null; _staticRefsVer = eng.ver;
    const cat = await prepareCatalogEmbeddings(prods);
    const pad = a => { const v = new Float32Array(EMB_DIM); v.set(a); return v; };
    const Q = qs.map(q => ({ ...q, emb: pad(q.emb), embBox: q.embBox ? pad(q.embBox) : null, embRef: q.embRef ? pad(q.embRef) : null, color: Float32Array.from(q.color), kind2: q.kind, kind: eng.kind, cw: eng.cw, margin: eng.margin }));
    const split = id => (strHash(String(id)) % 2 === 0 ? 'ajuste' : 'prueba');
    // rank del producto correcto, sin y con categoría.
    const rankOf = (items, list, id, category) => { const r = c => rankCatalogMulti(list, items, {}, c, Infinity).findIndex(x => String(x.p.id) === id) + 1; return [r('Todas'), r(category)]; };
    const by = {}; for (const q of Q) (by[q.id] ||= []).push(q);
    const groups = {};
    const add = (g, sp, rk) => { ((groups[g] ||= {})[sp] ||= []).push(rk); };
    for (const [id, list] of Object.entries(by)) {
      const sp = split(id), c = list[0].category, f = (k, s) => list.find(q => q.kind2 === k && q.k === s);
      const A = [0, 1, 2, 3].map(s => f('A', s)), B = [0, 1, 2, 3].map(s => f('B', s));
      for (const q of [...A, ...B]) add('1 foto (A o B)', sp, rankOf(cat.items, [q], id, c));
      if (wantMulti) {
        for (const pr of [[A[0], B[1]], [A[2], B[3]], [A[1], A[3]], [B[0], B[2]]]) add('2 fotos', sp, rankOf(cat.items, pr, id, c));
        for (const tr of [[A[0], B[1], A[2]], [B[0], A[1], B[3]]]) add('3 fotos', sp, rankOf(cat.items, tr, id, c));
        // Otra foto real del producto (sin sus referencias: se quita de images[] como en la fase 3).
        for (const url of [...new Set(list.filter(q => q.url).map(q => q.url))]) {
          const hidden = await prepareCatalogEmbeddings(prods.map(p => String(p.id) === id ? { ...p, images: (p.images || []).filter(u => u !== url) } : p));
          const o0 = list.find(q => q.url === url && q.kind2 === 'otra-foto'), o1 = list.find(q => q.url === url && q.kind2 === 'otra-foto+A' && q.k === 0), o2 = list.find(q => q.url === url && q.kind2 === 'otra-foto+A' && q.k === 1);
          for (const q of [o0, o1, o2]) add('otra foto, 1', sp, rankOf(hidden.items, [q], id, c));
          for (const pr of [[o0, o1], [o1, o2]]) add('otra foto, 2', sp, rankOf(hidden.items, pr, id, c));
          add('otra foto, 3', sp, rankOf(hidden.items, [o0, o1, o2], id, c));
        }
      }
      if (wantBox) for (const q of [...A, ...B]) add('1 foto, caja exacta', sp, rankOf(cat.items, [{ ...q, emb: q.embBox }], id, c));
    }
    // --doubt (v2.2): aviso de duda = margen 1ro − 2do < umbral (1 foto). Precisión = avisos que eran
    // errores del 1er puesto; recall = errores del 1er puesto que tuvieron aviso.
    if (wantDoubt) {
      const rows = { ajuste: [], prueba: [] };
      for (const [id, list] of Object.entries(by)) for (const q of list.filter(q => q.kind2 === 'A' || q.kind2 === 'B')) {
        const r = rankCatalogMulti([q], cat.items, {}, 'Todas', Infinity);
        rows[split(id)].push({ m: r[0].score - r[1].score, wrong: String(r[0].p.id) !== id });
      }
      groups.__doubt = Object.fromEntries(Object.entries(rows).map(([sp, rr]) => [sp, [0.02, 0.03, 0.04, 0.05, 0.06].map(t => {
        const al = rr.filter(x => x.m < t), tp = al.filter(x => x.wrong).length, errs = rr.filter(x => x.wrong).length;
        return { t, avisos: al.length, n: rr.length, precision: al.length ? tp / al.length : 0, recall: errs ? tp / errs : 0, errores: errs };
      })]));
    }
    // --learned (v2.3): fotos reales simuladas = otras 3 fotos de prueba de cada pieza (int8, como el
    // Worker; mismo generador → fondo compartido con la foto a identificar). Escenarios: (a) todas las
    // piezas con 3 fotos reales, (b) solo la correcta, (c) ~30 % de las piezas, (d) ninguna.
    // "v2.2" = foto real con las 5 vistas, sin margen ni fondo común (+ prototipo); "v2.3" = panel actual.
    if (wantProto) {
      const K = 3, keysAB = [['A', 0], ['A', 1], ['A', 2], ['A', 3], ['B', 0], ['B', 1], ['B', 2], ['B', 3]];
      const settings = { 'v2.2': { field: 'emb', opts: { bgMin: Infinity, m: 0, mp: 0 } }, 'v2.3': { field: 'embRef', opts: {} } };
      const pick = (list, skip, field) => keysAB.filter(([k, s]) => !(skip && skip.kind2 === k && skip.k === s)).slice(0, K).map(([k, s]) => { const q = list.find(q => q.kind2 === k && q.k === s); return quantizeEmb(q[field] || q.emb); });
      const in30 = id => strHash(id + '|30') % 10 < 3;
      const out = {};
      for (const [sname, st] of Object.entries(settings)) for (const scen of ['a', 'b', 'c', 'd']) {
        const r = { ajuste: [], prueba: [] };
        for (const [id, list] of Object.entries(by)) for (const q of list.filter(q => q.kind2 === 'A' || q.kind2 === 'B')) {
          const raw = {};
          if (scen !== 'd') for (const [pid, pl] of Object.entries(by)) {
            if (scen === 'b' && pid !== id) continue;
            if (scen === 'c' && !in30(pid)) continue;
            raw[pid] = pick(pl, pid === id ? q : null, st.field);
          }
          const learned = prepareLearnedRefs(raw, st.opts);
          r[split(id)].push(rankCatalog(q, cat.items, learned, 'Todas', Infinity).findIndex(x => String(x.p.id) === id) + 1);
        }
        out[sname + ' ' + scen] = r;
      }
      groups.__learned = out;
    }
    return groups;
  }, [d21.q, catalog.products, !!opt('multi', false), !!opt('box', false), !!opt('doubt', false), !!opt('learned', false)]);
  console.log('\n== v2.1 (funciones reales del panel; mitad de prueba | mitad de ajuste) ==');
  const doubt = res.__doubt, learned = res.__learned; delete res.__doubt; delete res.__learned;
  if (doubt) for (const [sp, rows] of Object.entries(doubt)) for (const r of rows) console.log(`  duda ${sp}: margen < ${r.t} → avisos ${r.avisos}/${r.n} (${(100 * r.avisos / r.n).toFixed(0)} %), precisión ${(100 * r.precision).toFixed(0)} %, recall ${(100 * r.recall).toFixed(0)} % de ${r.errores} errores`);
  if (learned) {
    const h = a => (100 * a.filter(x => x === 1).length / a.length).toFixed(1);
    for (const sp of ['ajuste', 'prueba']) {
      console.log(`  fotos reales simuladas, mitad de ${sp} (hit@1: a todas · b solo la correcta · c 30 % · d ninguna · peor caso):`);
      for (const st of ['v2.2', 'v2.3']) { const v = ['a', 'b', 'c', 'd'].map(sc => h(learned[st + ' ' + sc][sp])); console.log(`    ${st}: a ${v[0]} · b ${v[1]} · c ${v[2]} · d ${v[3]} · peor ${Math.min(...v.map(Number)).toFixed(1)} %`); }
    }
  }
  for (const [g, bySplit] of Object.entries(res)) {
    const f = r => { const n = r.length, h = j => (100 * r.filter(x => x[j] === 1).length / n).toFixed(1), h5 = j => (100 * r.filter(x => x[j] >= 1 && x[j] <= 5).length / n).toFixed(1); return `n=${n} hit@1 ${h(0)} % hit@5 ${h5(0)} % | categoría ${h(1)} % / ${h5(1)} %`; };
    console.log(`  ${g.padEnd(22)} prueba: ${f(bySplit.prueba || [])}   ajuste: ${f(bySplit.ajuste || [])}`);
  }
}
// ── Fase 5 (--quality): calibración del aviso "salió oscura/movida" (photoQuality) ──
// Ninguna foto del catálogo debe disparar el aviso; se cuenta también cuántas versiones
// oscurecidas (brillo 30 %) y desenfocadas (6 px) sí lo disparan, y las fotos de prueba A/B.
if (opt('quality', false)) {
  const { page: pg, localUrl } = await page();
  const urls = [...new Set(catalog.products.flatMap(productUrls))];
  const rows = [];
  for (const u of urls) rows.push(await pg.evaluate(async src => {
    const img = await loadImg(src, false);
    const mk = f => { const cv = document.createElement('canvas'); cv.width = img.naturalWidth; cv.height = img.naturalHeight; const c = cv.getContext('2d'); c.filter = f; c.drawImage(img, 0, 0); return cv; };
    const flag = q => q.dark || q.blurry, seed = strHash(src);
    const A = await loadImg(makeTestPhoto(img, seed, 'A'), false), B = await loadImg(makeTestPhoto(img, seed, 'B'), false);
    const o = photoQuality(img);
    return { lum: o.lum, lap: o.lap, orig: flag(o), dark: flag(photoQuality(mk('brightness(0.3)'))), blur: flag(photoQuality(mk('blur(6px)'))), A: flag(photoQuality(A)), B: flag(photoQuality(B)) };
  }, localUrl(u)));
  const cnt = k => rows.filter(r => r[k]).length;
  console.log(`\n== Aviso de calidad (${rows.length} fotos del catálogo) ==`);
  console.log(`  catálogo: ${cnt('orig')} avisos (luminancia mín. ${Math.min(...rows.map(r => r.lum)).toFixed(0)}, nitidez mín. ${Math.min(...rows.map(r => r.lap)).toFixed(0)})`);
  console.log(`  oscurecidas: ${cnt('dark')} · desenfocadas: ${cnt('blur')} · fotos de prueba A: ${cnt('A')} · B: ${cnt('B')} (de ${rows.length})`);
}
if (rp) await rp.close();
