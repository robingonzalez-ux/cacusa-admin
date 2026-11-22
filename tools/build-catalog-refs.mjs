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
// Opciones: --n 12 (variantes por foto), --tfjs <tf.min.js local> (sin acceso a jsdelivr).
// Tarda ~10–15 min (la mayor parte, los autovalores de 2 matrices de 1952×1952 en JS).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Matrix, EigenvalueDecomposition } from 'ml-matrix';
import { ADMIN_DIR, SITE_ORIGIN, openRecognitionPage, downloadSite, productUrls } from './recog-page.mjs';

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
const orphans = fs.existsSync(imgDir) ? fs.readdirSync(imgDir).sort().filter(f => /\.(webp|jpe?g|png)$/i.test(f) && !used.has('/ui_kits/store/images/' + f)).map(f => SITE_ORIGIN + '/ui_kits/store/images/' + f) : [];

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
    photos.push({ ...job, sha: fsha, color: rawCache[ckey].color, raws: rawCache[ckey].raws.map(b => new Float32Array(Buffer.from(b, 'base64').buffer.slice(0))) });
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
  const raws = res.raws.map(b => new Float32Array(Buffer.from(b, 'base64').buffer.slice(0)));
  if (raws.some(v => v.length !== SPEC.dIn)) throw new Error('dimensión inesperada del descriptor');
  photos.push({ ...job, sha: fsha, color: res.color, raws });
  rawCache[ckey] = res;
  process.stdout.write(`\r  1/3 descriptores: ${i + 1}/${jobs.length} fotos · ${secs()}   `);
}
await rp.close();
fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true }); fs.writeFileSync(CACHE_FILE, JSON.stringify(rawCache));
const nProd = photos.filter(p => p.id).length, nOrph = photos.length - nProd;
console.log(`\n  fotos usadas para aprender la proyección: ${photos.length} (${nProd} de productos + ${nOrph} sueltas) × ${N + 1} = ${photos.length * (N + 1)} vectores`);

// ── 2) Proyección (learned whitening) ──
const D = SPEC.dIn, X = photos.flatMap(p => p.raws), nX = X.length;
const mu64 = new Float64Array(D);
for (const x of X) for (let i = 0; i < D; i++) mu64[i] += x[i] / nX;
const mu = Float32Array.from(mu64); // lo que usa el panel
// Covarianza dentro de cada grupo (foto + sus variantes).
const Cw = new Float64Array(D * D);
for (const p of photos) {
  const g = new Float64Array(D); for (const x of p.raws) for (let i = 0; i < D; i++) g[i] += x[i] / p.raws.length;
  for (const x of p.raws) {
    const d = new Float64Array(D); for (let i = 0; i < D; i++) d[i] = x[i] - g[i];
    for (let i = 0; i < D; i++) { const di = d[i]; if (!di) continue; const r = i * D; for (let j = i; j < D; j++) Cw[r + j] += di * d[j]; }
  }
}
const CwM = new Matrix(D, D);
for (let i = 0; i < D; i++) for (let j = i; j < D; j++) { const v = Cw[i * D + j] / nX; CwM.set(i, j, v); CwM.set(j, i, v); }
process.stdout.write(`  2/3 proyección: autovalores (1 de 2)… ${secs()}\n`);
const e1 = new EigenvalueDecomposition(CwM, { assumeSymmetric: true });
const w1 = e1.realEigenvalues, V1 = e1.eigenvectorMatrix, wmax = Math.max(...w1);
const Wi = new Matrix(D, D); // Cw^-1/2 (en la base de autovectores)
for (let j = 0; j < D; j++) { const s = 1 / Math.sqrt(Math.max(w1[j], 0) + SPEC.eps * wmax); for (let i = 0; i < D; i++) Wi.set(i, j, V1.get(i, j) * s); }
const Xc = new Matrix(nX, D); X.forEach((x, r) => { for (let i = 0; i < D; i++) Xc.set(r, i, x[i] - mu64[i]); });
const Xw = Xc.mmul(Wi);
const Cb = Xw.transpose().mmul(Xw).div(nX);
process.stdout.write(`  2/3 proyección: autovalores (2 de 2)… ${secs()}\n`);
const e2 = new EigenvalueDecomposition(Cb, { assumeSymmetric: true });
const order = e2.realEigenvalues.map((v, i) => [v, i]).sort((a, b) => b[0] - a[0]).slice(0, SPEC.dOut).map(x => x[1]);
const V2 = new Matrix(D, SPEC.dOut); order.forEach((c, j) => { for (let i = 0; i < D; i++) V2.set(i, j, e2.eigenvectorMatrix.get(i, c)); });
const Wf = Wi.mmul(V2); // D × dOut
// Cuantización por columna a int8.
const dO = SPEC.dOut, scale = new Float32Array(dO), Wq = new Int8Array(D * dO);
for (let j = 0; j < dO; j++) { let m = 0; for (let i = 0; i < D; i++) m = Math.max(m, Math.abs(Wf.get(i, j))); scale[j] = m / 127 || 1; }
for (let i = 0; i < D; i++) for (let j = 0; j < dO; j++) Wq[i * dO + j] = Math.max(-127, Math.min(127, Math.round(Wf.get(i, j) / scale[j])));
const projBin = Buffer.concat([Buffer.from(mu.buffer), Buffer.from(scale.buffer), Buffer.from(Wq.buffer)]);
const Wdq = Float32Array.from(Wq, (q, k) => q * scale[k % dO]);
const project = x => { // mismo cálculo que projectV2 del panel (sin el relleno con ceros)
  const y = new Float64Array(dO);
  for (let i = 0; i < D; i++) { const xi = x[i] - mu[i]; if (!xi) continue; const r = i * dO; for (let j = 0; j < dO; j++) y[j] += xi * Wdq[r + j]; }
  let s = 0; for (const v of y) s += v * v; s = Math.sqrt(s) || 1; return y.map(v => v / s);
};
const q8 = y => { let m = 0; for (const v of y) m = Math.max(m, Math.abs(v)); const k = m ? 127 / m : 0; return Int8Array.from(y, v => Math.max(-127, Math.min(127, Math.round(v * k)))); };

// ── 3) Referencias precalculadas de los productos ──
const chunks = [], index = {};
let offset = 0;
for (const p of photos) {
  if (!p.id) continue;
  for (const x of p.raws) chunks.push(Buffer.from(q8(project(x)).buffer));
  (index[p.id] ||= []).push({ url: p.url, sha256: p.sha, offset, n: p.raws.length - 1, color: p.color });
  offset += p.raws.length;
}
const bin = Buffer.concat(chunks);
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const generated = new Date().toISOString();
const refsOut = {
  format: 'cacusa-catalog-refs', version: 2,
  model: SPEC.emb, aug: 'aug-v1', dim: dO, quant: 'int8-maxabs', perImage: { base: 1, aug: N },
  layout: 'por foto: offset = huella base, offset+1 … offset+n = variantes aumentadas (vectores de dim bytes; el panel los rellena con ceros hasta 1280)',
  generated, catalogProducts: (catalog.products || []).length,
  bin: 'catalog-refs-v2.bin', binBytes: bin.length, binSha256: sha(bin), vectors: offset,
  products: index,
};
const manifest = {
  format: 'cacusa-recog', version: 2, emb: SPEC.emb, model: SPEC.model, size: SPEC.size,
  dIn: SPEC.dIn, parts: SPEC.parts, views: SPEC.views, dOut: dO,
  cw: SPEC.cw, margin: SPEC.margin, pct: SPEC.pct,
  refs: 'models/catalog-refs-v2.json',
  proj: { bin: 'recog-v2-proj.bin', binBytes: projBin.length, binSha256: sha(projBin), method: 'learned-whitening', eps: SPEC.eps,
          layout: 'mu float32[dIn] · escala float32[dOut] · W int8[dIn×dOut] por filas (W real = int8 × escala de su columna)',
          trainedOn: { photos: photos.length, productPhotos: nProd, otherSitePhotos: nOrph, variantsPerPhoto: N, vectors: nX } },
  generated,
};
fs.writeFileSync(path.join(MODELS, 'recog-v2-proj.bin'), projBin);
fs.writeFileSync(path.join(MODELS, 'catalog-refs-v2.bin'), bin);
fs.writeFileSync(path.join(MODELS, 'catalog-refs-v2.json'), JSON.stringify(refsOut));
fs.writeFileSync(path.join(MODELS, 'recog-v2.json'), JSON.stringify(manifest, null, 1) + '\n');
console.log(`  3/3 listo en ${secs()}: ${Object.keys(index).length} productos, ${nProd} fotos, ${offset} vectores.`);
for (const f of ['recog-v2.json', 'recog-v2-proj.bin', 'catalog-refs-v2.bin', 'catalog-refs-v2.json']) console.log(`  models/${f}  ${(fs.statSync(path.join(MODELS, f)).size / 1024).toFixed(0)} KB`);
if (skipped) console.log(`  ${skipped} foto(s) omitidas (sin archivo o ilegibles).`);
