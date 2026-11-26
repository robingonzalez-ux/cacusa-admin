#!/usr/bin/env node
// Genera los archivos del reconocimiento por foto v2 del panel ("entrenamiento"):
//   models/recog-v2.json        manifiesto (versión de la huella, red, vistas, pesos, calibración)
//   models/recog-v2-proj.bin    proyección "learned whitening" 1952 → 512 (mu f32 · escala f32 · W int8)
//   models/catalog-refs-v2.bin  referencias precalculadas (int8, 512 por vector)
//   models/catalog-refs-v2.json índice de las referencias
//
// 1) En Chromium headless, con el código del propio panel (bloque @@recog de index.html) y la
//    misma red (models/effv2b0_288/), calcula el descriptor SIN proyectar (rawV2) de cada foto
//    y de N variantes aumentadas (augmentPhoto, misma semilla que el panel). Usa TODAS las fotos:
//    imageUrl + images[] de todos los productos (también los pausados) y las demás fotos de
//    ui_kits/store/images/ que ya no usa ningún producto (fotos viejas/reemplazadas).
// 2) Aprende la proyección con todas esas fotos (sin etiquetas de producto: cada foto con sus
//    variantes es un grupo): blanqueo de la variación DENTRO de cada grupo (lo que cambia entre
//    una toma y otra de la misma pieza: luz, fondo, recorte, giro) + PCA entre grupos.
// 3) Proyecta y guarda las referencias de las fotos de los productos (base + N variantes).
//
// Uso (ver README, "Reconocimiento por foto"):
//   cd tools && npm install && npx playwright install chromium
//   node build-catalog-refs.mjs --download          # baja products.json y fotos del sitio público
//   node build-catalog-refs.mjs --site ../../cacusa  # usa una copia local del repo de la tienda
// Opciones: --n 12 (variantes por foto), --tfjs <tf.min.js local> (sin acceso a jsdelivr),
//           --keep-proj (no reaprende las proyecciones: solo recalcula las referencias, p. ej. productos nuevos).
// Las fotos de galería con modelo/de ambiente no se usan como referencia (galleryRefMask del panel):
// se listan por SKU en la salida y quedan en "excluded" del índice (solo huella base + borde).
// Tarda ~10–15 min (la mayor parte, los autovalores de 2 matrices de 1952×1952 en JS).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Matrix, EigenvalueDecomposition } from 'ml-matrix';
import { ADMIN_DIR, SITE_ORIGIN, openRecognitionPage, downloadSite, productUrls, loadGalleryRule } from './recog-page.mjs';

// Descriptor v2 (medido con eval-catalog-refs.mjs; ver README). Cambiar cualquiera de estos
// valores cambia la huella → cambiar `emb` y regenerar (las fotos reales aprendidas quedan viejas).
const SPEC = {
  emb: 'effv2b0-288-gem2-iso5-lw512-v2',
  model: 'models/effv2b0_288/model.json', size: 288,
  dIn: 1952, parts: [[0, 1280], [1280, 1952]],       // GeM top_activation | GeM block6a_expand_activation
  views: [['c', 1], ['c', 0.8], ['c', 0.6], ['p', 1.25], ['p', 1.6]],
  dOut: 512, eps: 0.01,                                // proyección: dimensiones y regularización
  cw: 0.05, margin: 0.03,
  pct: [0.15, 0.65],                                   // friendlyPct: puntaje que da 0 % y rango hasta 100 % (calibrado: acierto típico ≈ 0,53 → ~60 %, mejor error típico ≈ 0,29 → ~20 %)
};

// v3 (25 nov): v2 + DINOv2-small (ONNX int8) fusionados: [√α · v2 (512) ; √(1−α) · DINOv2 (384)].
// α elegido con la mitad de ajuste sintética y las 30 fotos reales (ver README, v3).
const SPEC3 = {
  emb: 'effv2b0-dinov2s-int8-a045-v3', alpha: 0.45,
  dino: { model: 'models/dinov2-small/model_quantized.onnx', size: 224, dIn: 384, dOut: 384, eps: 0.01 },
  cw: 0.05, margin: 0.03,
  pct: [0.15, 0.65],
};
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf('--' + name); return i >= 0 ? (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true) : def; };
const N = Number(opt('n', 12));
const MODELS = path.join(ADMIN_DIR, 'models');
let siteDir = opt('site', null);
if (opt('download', false)) siteDir = await downloadSite(path.join(ADMIN_DIR, 'tools', '.cache', 'site'));
if (!siteDir || siteDir === true) { console.error('Indica --site <carpeta con data/products.json y ui_kits/store/images> o --download'); process.exit(2); }
siteDir = path.resolve(siteDir);
const catalog = JSON.parse(fs.readFileSync(path.join(siteDir, 'data', 'products.json'), 'utf8'));
const products = (catalog.products || []).filter(p => p && p.id != null && productUrls(p).length);
// Fotos del sitio que no usa ningún producto (solo para aprender la proyección).
const used = new Set(products.flatMap(productUrls).map(u => new URL(u).pathname));
const imgDir = path.join(siteDir, 'ui_kits', 'store', 'images');
const orphans = opt('keep-proj', false) ? [] : fs.existsSync(imgDir) ? fs.readdirSync(imgDir).sort().filter(f => /\.(webp|jpe?g|png)$/i.test(f) && !used.has('/ui_kits/store/images/' + f)).map(f => SITE_ORIGIN + '/ui_kits/store/images/' + f) : [];

// base64 → Float32Array (copia exacta: Buffer.from puede compartir un bloque más grande)
const f32of = b => { const u = Buffer.from(b, 'base64'); return new Float32Array(u.buffer.slice(u.byteOffset, u.byteOffset + u.length)); };
const t0 = Date.now();
const secs = () => ((Date.now() - t0) / 1000).toFixed(0) + ' s';
const extraJs = `
async function __v2Engine(spec) {
  if (window.__eng) return window.__eng;
  const tf = await loadTfjs(); await tf.ready();
  const model = await tf.loadGraphModel(spec.model);
  window.__eng = { tf, model, kind: 'v2', ver: spec.emb, size: spec.size, parts: spec.parts, views: spec.views, proj: { dIn: spec.dIn } };
  return window.__eng;
}
function __b64f32(v) { const u = new Uint8Array(Float32Array.from(v).buffer); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); }`;
const openPage = async () => { const r = await openRecognitionPage({ siteDir, tfjsFile: opt('tfjs', null), extraJs, warmup: false }); r.page.on('crash', () => console.error('\n  Chromium se cayó: se reabre')); return r; };
let rp = await openPage();
console.log(`Chromium listo. ${products.length} productos, ${orphans.length} fotos sueltas, ${N} variantes por foto.`);

// ── 1) Descriptores sin proyectar ──
const photos = []; // { id|null, url, sha, color, raws: [Float32Array] (0 = base) }
const jobs = [...products.flatMap(p => productUrls(p).map(url => ({ id: String(p.id), url }))), ...orphans.map(url => ({ id: null, url }))].slice(0, Number(opt('limit', 1e9)));
let skipped = 0;
// Caché local de descriptores (tools/.cache/, no se publica): por huella + hash de la foto + N.
const CACHE_FILE = path.join(ADMIN_DIR, 'tools', '.cache', `raw-${SPEC.emb}.json`);
let rawCache = {};
try { rawCache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch (_) {}
for (const [i, job] of jobs.entries()) {
  const file = path.join(siteDir, decodeURIComponent(new URL(job.url).pathname));
  if (!fs.existsSync(file)) { skipped++; console.warn('\n  sin archivo local:', job.url); continue; }
  const fsha = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 16), ckey = `${job.url}|${fsha}|${N}`;
  if (rawCache[ckey]) {
    photos.push({ ...job, sha: fsha, color: rawCache[ckey].color, raws: rawCache[ckey].raws.map(b => f32of(b)) });
    continue;
  }
  const calc = () => rp.page.evaluate(async ([src, url, n, spec]) => {
    const eng = await __v2Engine(spec);
    const img = await loadImg(src, false);
    const raws = [rawV2(eng, img)];
    for (let k = 0; k < n; k++) raws.push(rawV2(eng, augmentPhoto(img, augSeed(url, k))));
    return { raws: raws.map(__b64f32), color: Array.from(colorDescriptor(img), x => Math.round(x * 1e4) / 1e4) };
  }, [rp.localUrl(job.url), job.url, N, SPEC]);
  let res = null;
  for (let attempt = 0; attempt < 2 && !res; attempt++) {
    try { res = await calc(); }
    catch (e) { // Chromium headless a veces se cae (memoria): se reabre y se reintenta una vez
      console.warn('\n  error con', job.url, e.message);
      try { await rp.close(); } catch (_) {}
      rp = await openPage();
    }
  }
  if (!res) { skipped++; continue; }
  const raws = res.raws.map(b => f32of(b));
  if (raws.some(v => v.length !== SPEC.dIn)) throw new Error('dimensión inesperada del descriptor');
  photos.push({ ...job, sha: fsha, color: res.color, raws });
  rawCache[ckey] = res;
  process.stdout.write(`\r  1/3 descriptores: ${i + 1}/${jobs.length} fotos · ${secs()}   `);
}
// Borde (borderUniformity, para la regla de fotos de galería): caché aparte por foto.
const BU_FILE = path.join(ADMIN_DIR, 'tools', '.cache', 'border-uniformity.json');
let buCache = {}; try { buCache = JSON.parse(fs.readFileSync(BU_FILE, 'utf8')); } catch (_) {}
for (const p of photos) {
  const k = `${p.url}|${p.sha}`;
  if (typeof buCache[k] !== 'number') buCache[k] = await rp.page.evaluate(async src => borderUniformity(await loadImg(src, false)), rp.localUrl(p.url));
  p.bu = buCache[k];
}
fs.mkdirSync(path.dirname(BU_FILE), { recursive: true }); fs.writeFileSync(BU_FILE, JSON.stringify(buCache));
await rp.close();
fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true }); fs.writeFileSync(CACHE_FILE, JSON.stringify(rawCache));
const nProd = photos.filter(p => p.id).length, nOrph = photos.length - nProd;
console.log(`\n  fotos usadas para aprender la proyección: ${photos.length} (${nProd} de productos + ${nOrph} sueltas) × ${N + 1} = ${photos.length * (N + 1)} vectores`);

// ── 2) Proyección (learned whitening) ──
// groups: [[Float32Array]] (cada foto con sus variantes es un grupo). Devuelve el binario
// (mu f32 · escala f32 · W int8) y project(x) = mismo cálculo que el panel (sin relleno).
function fitLW(groups, D, dOut, eps, label) {
  const X = groups.flat(), nX = X.length;
  const mu64 = new Float64Array(D);
  for (const x of X) for (let i = 0; i < D; i++) mu64[i] += x[i] / nX;
  const mu = Float32Array.from(mu64); // lo que usa el panel
  const Cw = new Float64Array(D * D); // covarianza dentro de cada grupo
  for (const raws of groups) {
    const g = new Float64Array(D); for (const x of raws) for (let i = 0; i < D; i++) g[i] += x[i] / raws.length;
    for (const x of raws) {
      const d = new Float64Array(D); for (let i = 0; i < D; i++) d[i] = x[i] - g[i];
      for (let i = 0; i < D; i++) { const di = d[i]; if (!di) continue; const r = i * D; for (let j = i; j < D; j++) Cw[r + j] += di * d[j]; }
    }
  }
  const CwM = new Matrix(D, D);
  for (let i = 0; i < D; i++) for (let j = i; j < D; j++) { const v = Cw[i * D + j] / nX; CwM.set(i, j, v); CwM.set(j, i, v); }
  process.stdout.write(`  2/3 proyección ${label}: autovalores (1 de 2)… ${secs()}\n`);
  const e1 = new EigenvalueDecomposition(CwM, { assumeSymmetric: true });
  const w1 = e1.realEigenvalues, V1 = e1.eigenvectorMatrix, wmax = Math.max(...w1);
  const Wi = new Matrix(D, D); // Cw^-1/2 (en la base de autovectores)
  for (let j = 0; j < D; j++) { const s = 1 / Math.sqrt(Math.max(w1[j], 0) + eps * wmax); for (let i = 0; i < D; i++) Wi.set(i, j, V1.get(i, j) * s); }
  const Xc = new Matrix(nX, D); X.forEach((x, r) => { for (let i = 0; i < D; i++) Xc.set(r, i, x[i] - mu64[i]); });
  const Xw = Xc.mmul(Wi);
  const Cb = Xw.transpose().mmul(Xw).div(nX);
  process.stdout.write(`  2/3 proyección ${label}: autovalores (2 de 2)… ${secs()}\n`);
  const e2 = new EigenvalueDecomposition(Cb, { assumeSymmetric: true });
  const dO = Math.min(dOut, D);
  const order = e2.realEigenvalues.map((v, i) => [v, i]).sort((a, b) => b[0] - a[0]).slice(0, dO).map(x => x[1]);
  const V2 = new Matrix(D, dO); order.forEach((c, j) => { for (let i = 0; i < D; i++) V2.set(i, j, e2.eigenvectorMatrix.get(i, c)); });
  const Wf = Wi.mmul(V2); // D × dO
  const scale = new Float32Array(dO), Wq = new Int8Array(D * dO); // cuantización por columna a int8
  for (let j = 0; j < dO; j++) { let m = 0; for (let i = 0; i < D; i++) m = Math.max(m, Math.abs(Wf.get(i, j))); scale[j] = m / 127 || 1; }
  for (let i = 0; i < D; i++) for (let j = 0; j < dO; j++) Wq[i * dO + j] = Math.max(-127, Math.min(127, Math.round(Wf.get(i, j) / scale[j])));
  const projBin = Buffer.concat([Buffer.from(mu.buffer), Buffer.from(scale.buffer), Buffer.from(Wq.buffer)]);
  const Wdq = Float32Array.from(Wq, (q, k) => q * scale[k % dO]);
  const project = x => {
    const y = new Float64Array(dO);
    for (let i = 0; i < D; i++) { const xi = x[i] - mu[i]; if (!xi) continue; const r = i * dO; for (let j = 0; j < dO; j++) y[j] += xi * Wdq[r + j]; }
    let s = 0; for (const v of y) s += v * v; s = Math.sqrt(s) || 1; return y.map(v => v / s);
  };
  return { projBin, project, dOut: dO, nX };
}
// --keep-proj: no se vuelven a aprender las proyecciones; se usan las de models/ tal cual y solo se
// recalculan las referencias (p. ej. al agregar productos). Mismo cálculo que el panel.
const KEEP = !!opt('keep-proj', false);
function loadLW(file, D, dOut) {
  const buf = fs.readFileSync(file);
  if (buf.length !== (D + dOut) * 4 + D * dOut) throw new Error('proyección con tamaño inesperado: ' + file);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length);
  const mu = new Float32Array(ab, 0, D), scale = new Float32Array(ab, D * 4, dOut), Wq = new Int8Array(ab, (D + dOut) * 4, D * dOut);
  const Wdq = Float32Array.from(Wq, (q, k) => q * scale[k % dOut]);
  const project = x => {
    const y = new Float64Array(dOut);
    for (let i = 0; i < D; i++) { const xi = x[i] - mu[i]; if (!xi) continue; const r = i * dOut; for (let j = 0; j < dOut; j++) y[j] += xi * Wdq[r + j]; }
    let s2 = 0; for (const v of y) s2 += v * v; s2 = Math.sqrt(s2) || 1; return y.map(v => v / s2);
  };
  return { projBin: buf, project, dOut, nX: 0 };
}
const D = SPEC.dIn;
const effLW = KEEP ? loadLW(path.join(MODELS, 'recog-v2-proj.bin'), D, SPEC.dOut) : fitLW(photos.map(p => p.raws), D, SPEC.dOut, SPEC.eps, 'EfficientNetV2');
const { projBin, project } = effLW, dO = effLW.dOut, nX = effLW.nX;
const q8 = y => { let m = 0; for (const v of y) m = Math.max(m, Math.abs(v)); const k = m ? 127 / m : 0; return Int8Array.from(y, v => Math.max(-127, Math.min(127, Math.round(v * k)))); };
const sha = b => crypto.createHash('sha256').update(b).digest('hex');


// ── 4) v3: DINOv2-small (ONNX Runtime Web, wasm con hilos en Chromium headless) ──
const dinoFile = path.join(ADMIN_DIR, SPEC3.dino.model), dinoBuf = fs.readFileSync(dinoFile), dinoSha = sha(dinoBuf);
const CACHE3 = path.join(ADMIN_DIR, 'tools', '.cache', `raw-dino-${dinoSha.slice(0, 12)}.json`);
let cache3 = {}; try { cache3 = JSON.parse(fs.readFileSync(CACHE3, 'utf8')); } catch (_) {}
const dinoJs = extraJs + `
async function __dinoEngine(spec, spec3) {
  if (window.__deng) return window.__deng;
  await new Promise((ok, ko) => { const s = document.createElement('script'); s.src = '/vendor/onnxruntime-web/ort.wasm.min.js'; s.onload = ok; s.onerror = ko; document.head.appendChild(s); });
  ort.env.wasm.wasmPaths = location.origin + '/vendor/onnxruntime-web/'; ort.env.wasm.numThreads = self.crossOriginIsolated ? 4 : 1;
  const sess = await ort.InferenceSession.create('/' + spec3.dino.model, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
  window.__deng = { views: spec.views, dino: { ort, sess, size: spec3.dino.size, nreg: 0 } };
  return window.__deng;
}`;
let rp3 = null;
const open3 = async () => { const r = await openRecognitionPage({ siteDir, tfjsFile: opt('tfjs', null), extraJs: dinoJs, warmup: false }); r.page.on('crash', () => console.error('\n  Chromium se cayó: se reabre')); return r; };
for (const [i, p] of photos.entries()) {
  const ckey = `${p.url}|${p.sha}|${N}`;
  if (!cache3[ckey]) {
    rp3 ||= await open3();
    let res = null;
    for (let attempt = 0; attempt < 2 && !res; attempt++) {
      try {
        res = await rp3.page.evaluate(async ([src, url, n, spec, spec3]) => {
          const eng = await __dinoEngine(spec, spec3);
          const img = await loadImg(src, false);
          const raws = [(await rawDinoBoth(eng, img)).all];
          for (let k = 0; k < n; k++) raws.push((await rawDinoBoth(eng, augmentPhoto(img, augSeed(url, k)))).all);
          return raws.map(__b64f32);
        }, [rp3.localUrl(p.url), p.url, N, SPEC, SPEC3]);
      } catch (e) { console.warn('\n  error DINOv2 con', p.url, e.message); try { await rp3.close(); } catch (_) {} rp3 = await open3(); }
    }
    if (!res) throw new Error('DINOv2 falló con ' + p.url);
    cache3[ckey] = res;
  }
  p.draws = cache3[ckey].map(b => f32of(b));
  if (p.draws.some(v => v.length !== SPEC3.dino.dIn)) throw new Error('dimensión inesperada de DINOv2');
  process.stdout.write(`\r  4/4 DINOv2: ${i + 1}/${photos.length} fotos · ${secs()}   `);
}
if (rp3) await rp3.close();
fs.writeFileSync(CACHE3, JSON.stringify(cache3));
console.log('');
const dinoLW = KEEP ? loadLW(path.join(MODELS, 'recog-v3-proj-dino.bin'), SPEC3.dino.dIn, Math.min(SPEC3.dino.dOut, SPEC3.dino.dIn)) : fitLW(photos.map(p => p.draws), SPEC3.dino.dIn, SPEC3.dino.dOut, SPEC3.dino.eps, 'DINOv2');
const a3 = Math.sqrt(SPEC3.alpha), b3 = Math.sqrt(1 - SPEC3.alpha), dim3 = dO + dinoLW.dOut;
const fuse3 = (e, d) => { const pe = project(e), pd = dinoLW.project(d), y = new Float64Array(dim3); pe.forEach((v, i) => { y[i] = a3 * v; }); pd.forEach((v, i) => { y[dO + i] = b3 * v; }); return y; };
// ── 3) Fotos de galería que no sirven de referencia (fotos con modelo/de ambiente) ──
// Misma regla que el panel (galleryRefMask de index.html), con las huellas v3 tal como las ve el
// panel (int8 → normalizadas). Se aplica igual a v2 y v3 (la tienda usa v2). Las descartadas
// quedan en "excluded" (solo huella base + borde, para que el panel repita la regla sin bajarlas).
const { galleryRefMask, REF_CONSIST_MIN } = loadGalleryRule();
const deq = y => { const q = q8(y); let s2 = 0; for (const v of q) s2 += v * v; s2 = Math.sqrt(s2) || 1; return Float32Array.from(q, v => v / s2); };
const skuOf = new Map((catalog.products || []).map(p => [String(p.id), p.sku || p.code || String(p.id)]));
const byProd = new Map();
for (const p of photos) if (p.id) { if (!byProd.has(p.id)) byProd.set(p.id, []); byProd.get(p.id).push(p); }
let nExcl = 0; const exclLog = [];
for (const [id, list] of byProd) {
  const mask = galleryRefMask(list.map(p => ({ emb: deq(fuse3(p.raws[0], p.draws[0])), bu: p.bu })));
  list.forEach((p, k) => {
    p.excluded = !mask[k].keep;
    if (p.excluded) { nExcl++; exclLog.push(`    ${skuOf.get(id)}  ${p.url.split('/').pop()}  (coseno ${mask[k].cos.toFixed(2)}, borde ${p.bu.toFixed(2)})`); }
    else if (mask[k].anchor && k) exclLog.push(`    ${skuOf.get(id)}  ancla = foto de galería ${p.url.split('/').pop()} (la principal parece foto con modelo)`);
  });
}
console.log(`  fotos de galería descartadas como referencia (coseno con la foto de producto < ${REF_CONSIST_MIN}): ${nExcl}`);
for (const l of exclLog) console.log(l);
// ── 3b) Referencias precalculadas de los productos ──
const chunks = [], index = {}, excluded = {};
let offset = 0;
for (const p of photos) {
  if (!p.id) continue;
  const raws = p.excluded ? p.raws.slice(0, 1) : p.raws;
  for (const x of raws) chunks.push(Buffer.from(q8(project(x)).buffer));
  ((p.excluded ? excluded : index)[p.id] ||= []).push({ url: p.url, sha256: p.sha, offset, n: raws.length - 1, color: p.color, bu: p.bu });
  offset += raws.length;
}
const bin = Buffer.concat(chunks);
const generated = new Date().toISOString();
const refsOut = {
  format: 'cacusa-catalog-refs', version: 2,
  model: SPEC.emb, aug: 'aug-v1', dim: dO, quant: 'int8-maxabs', perImage: { base: 1, aug: N },
  layout: 'por foto: offset = huella base, offset+1 … offset+n = variantes aumentadas (vectores de dim bytes; el panel los rellena con ceros hasta 1280)',
  generated, catalogProducts: (catalog.products || []).length,
  bin: 'catalog-refs-v2.bin', binBytes: bin.length, binSha256: sha(bin), vectors: offset,
  products: index,
  excluded, excludedRule: { min: REF_CONSIST_MIN, by: SPEC3.emb },
};
const manifest = {
  format: 'cacusa-recog', version: 2, emb: SPEC.emb, model: SPEC.model, size: SPEC.size,
  dIn: SPEC.dIn, parts: SPEC.parts, views: SPEC.views, dOut: dO,
  cw: SPEC.cw, margin: SPEC.margin, pct: SPEC.pct,
  refs: 'models/catalog-refs-v2.json',
  proj: { bin: 'recog-v2-proj.bin', binBytes: projBin.length, binSha256: sha(projBin), method: 'learned-whitening', eps: SPEC.eps,
          layout: 'mu float32[dIn] · escala float32[dOut] · W int8[dIn×dOut] por filas (W real = int8 × escala de su columna)',
          trainedOn: KEEP ? JSON.parse(fs.readFileSync(path.join(MODELS, 'recog-v2.json'), 'utf8')).proj.trainedOn : { photos: photos.length, productPhotos: nProd, otherSitePhotos: nOrph, variantsPerPhoto: N, vectors: nX } },
  generated,
};
fs.writeFileSync(path.join(MODELS, 'recog-v2-proj.bin'), projBin);
fs.writeFileSync(path.join(MODELS, 'catalog-refs-v2.bin'), bin);
fs.writeFileSync(path.join(MODELS, 'catalog-refs-v2.json'), JSON.stringify(refsOut));
fs.writeFileSync(path.join(MODELS, 'recog-v2.json'), JSON.stringify(manifest, null, 1) + '\n');
console.log(`  3/3 listo en ${secs()}: ${Object.keys(index).length} productos, ${nProd} fotos, ${offset} vectores.`);
for (const f of ['recog-v2.json', 'recog-v2-proj.bin', 'catalog-refs-v2.bin', 'catalog-refs-v2.json']) console.log(`  models/${f}  ${(fs.statSync(path.join(MODELS, f)).size / 1024).toFixed(0)} KB`);
const chunks3 = [], index3 = {}, excluded3 = {}; let off3 = 0;
for (const p of photos) {
  if (!p.id) continue;
  const nk = p.excluded ? 1 : p.raws.length;
  p.raws.slice(0, nk).forEach((x, k) => chunks3.push(Buffer.from(q8(fuse3(x, p.draws[k])).buffer)));
  ((p.excluded ? excluded3 : index3)[p.id] ||= []).push({ url: p.url, sha256: p.sha, offset: off3, n: nk - 1, color: p.color, bu: p.bu });
  off3 += nk;
}
const bin3 = Buffer.concat(chunks3), dinoProjBin = dinoLW.projBin;
const refs3 = { ...refsOut, version: 3, model: SPEC3.emb, dim: dim3, bin: 'catalog-refs-v3.bin', binBytes: bin3.length, binSha256: sha(bin3), vectors: off3, products: index3, excluded: excluded3 };
const man3 = {
  format: 'cacusa-recog', version: 3, emb: SPEC3.emb, views: SPEC.views, alpha: SPEC3.alpha, dOut: dim3,
  cw: SPEC3.cw, margin: SPEC3.margin, pct: SPEC3.pct, refs: 'models/catalog-refs-v3.json',
  eff: { emb: SPEC.emb, model: SPEC.model, size: SPEC.size, dIn: SPEC.dIn, parts: SPEC.parts, dOut: dO, proj: manifest.proj },
  dino: { model: SPEC3.dino.model, sha256: dinoSha, bytes: dinoBuf.length, size: SPEC3.dino.size, registers: 0, dIn: SPEC3.dino.dIn, dOut: dinoLW.dOut,
          proj: { bin: 'recog-v3-proj-dino.bin', binBytes: dinoProjBin.length, binSha256: sha(dinoProjBin), method: 'learned-whitening', eps: SPEC3.dino.eps } },
  layout: 'huella = [√α · v2 proyectada (512) ; √(1−α) · DINOv2 proyectada (384)], rellenada con ceros hasta 1280',
  generated,
};
fs.writeFileSync(path.join(MODELS, 'recog-v3-proj-dino.bin'), dinoProjBin);
fs.writeFileSync(path.join(MODELS, 'catalog-refs-v3.bin'), bin3);
fs.writeFileSync(path.join(MODELS, 'catalog-refs-v3.json'), JSON.stringify(refs3));
fs.writeFileSync(path.join(MODELS, 'recog-v3.json'), JSON.stringify(man3, null, 1) + '\n');
for (const f of ['recog-v3.json', 'recog-v3-proj-dino.bin', 'catalog-refs-v3.bin', 'catalog-refs-v3.json']) console.log(`  models/${f}  ${(fs.statSync(path.join(MODELS, f)).size / 1024).toFixed(0)} KB`);
if (skipped) console.log(`  ${skipped} foto(s) omitidas (sin archivo o ilegibles).`);
