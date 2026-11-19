#!/usr/bin/env node
// Genera models/catalog-refs-v1.bin + models/catalog-refs-v1.json: las referencias
// precalculadas ("entrenamiento") del reconocimiento por foto del panel.
//
// Por cada foto de cada producto (imageUrl + images[]) guarda:
//   - 1 huella "base" (la misma que el panel calcula para el catálogo: recorte completo), y
//   - N huellas de variantes aumentadas (augmentPhoto: mesa, recorte, giro, luz, etc.),
//     cada una con el mismo promedio de 3 recortes que la foto a identificar.
// Todo se calcula en Chromium headless con el código del propio panel (bloque @@recog de
// index.html) y el mismo TF.js + MobileNet v2, así los números coinciden con el navegador.
// Cuantización igual que las referencias del Worker: L2 → int8 (escala por el máx. absoluto).
//
// Uso (ver README, sección "Reconocimiento por foto"):
//   cd tools && npm install && npx playwright install chromium
//   node build-catalog-refs.mjs --download          # baja products.json y fotos del sitio público
//   node build-catalog-refs.mjs --site ../../cacusa  # usa una copia local del repo de la tienda
// Opciones: --n 12 (variantes por foto), --tfjs <tf.min.js local> (sin acceso a jsdelivr),
//           --out <prefijo> (por defecto ../models/catalog-refs-v1).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ADMIN_DIR, openRecognitionPage, downloadSite, productUrls } from './recog-page.mjs';

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf('--' + name); return i >= 0 ? (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true) : def; };
const N = Number(opt('n', 12));
const OUT = path.resolve(opt('out', path.join(ADMIN_DIR, 'models', 'catalog-refs-v1')));
let siteDir = opt('site', null);
if (opt('download', false)) siteDir = await downloadSite(path.join(ADMIN_DIR, 'tools', '.cache', 'site'));
if (!siteDir || siteDir === true) { console.error('Indica --site <carpeta con data/products.json y ui_kits/store/images> o --download'); process.exit(2); }
siteDir = path.resolve(siteDir);
const catalog = JSON.parse(fs.readFileSync(path.join(siteDir, 'data', 'products.json'), 'utf8'));
const products = (catalog.products || []).filter(p => p && p.id != null && productUrls(p).length);

const t0 = Date.now();
const rp = await openRecognitionPage({ siteDir, tfjsFile: opt('tfjs', null) });
const meta = await rp.page.evaluate(() => ({ model: EMB_VERSION, aug: AUG_VERSION, dim: EMB_DIM }));
console.log(`Chromium listo (backend ${rp.backend}). ${products.length} productos, ${N} variantes por foto.`);

const chunks = [], index = {};
let offset = 0, nImages = 0, skipped = 0;
for (const [pi, p] of products.entries()) {
  const entries = [];
  for (const url of productUrls(p)) {
    const file = path.join(siteDir, new URL(url).pathname);
    if (!fs.existsSync(file)) { skipped++; console.warn('  sin archivo local:', url); continue; }
    const sha = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 16);
    const res = await rp.page.evaluate(async ([src, url, n]) => {
      const eng = await loadRecognitionModel();
      const img = await loadImg(src, false);
      const base = embedCanvas(eng, squareCrop(img, 1, 224));
      const aug = augmentEmbeddings(eng, img, url, n);
      return { vecs: [base, ...aug].map(quantizeEmb), color: Array.from(colorDescriptor(img), x => Math.round(x * 1e4) / 1e4) };
    }, [rp.localUrl(url), url, N]).catch(e => { console.warn('  error con', url, e.message); return null; });
    if (!res) { skipped++; continue; }
    for (const b64 of res.vecs) chunks.push(Buffer.from(b64, 'base64'));
    entries.push({ url, sha256: sha, offset, n: N, color: res.color });
    offset += res.vecs.length; nImages++;
  }
  if (entries.length) index[String(p.id)] = entries;
  process.stdout.write(`\r  ${pi + 1}/${products.length} productos · ${nImages} fotos · ${((Date.now() - t0) / 1000).toFixed(0)} s   `);
}
await rp.close();
const bin = Buffer.concat(chunks);
if (bin.length !== offset * meta.dim) throw new Error('tamaño inesperado del .bin');
const binSha = crypto.createHash('sha256').update(bin).digest('hex');
const out = {
  format: 'cacusa-catalog-refs', version: 1,
  model: meta.model, aug: meta.aug, dim: meta.dim, quant: 'int8-maxabs', perImage: { base: 1, aug: N },
  layout: 'por foto: offset = huella base, offset+1 … offset+n = variantes aumentadas (vectores de dim bytes)',
  generated: new Date().toISOString(), catalogProducts: (catalog.products || []).length,
  bin: path.basename(OUT) + '.bin', binBytes: bin.length, binSha256: binSha, vectors: offset,
  products: index,
};
fs.writeFileSync(OUT + '.bin', bin);
fs.writeFileSync(OUT + '.json', JSON.stringify(out));
console.log(`\nListo en ${((Date.now() - t0) / 1000).toFixed(0)} s: ${Object.keys(index).length} productos, ${nImages} fotos, ${offset} vectores.`);
console.log(`  ${OUT}.bin  ${(bin.length / 1024).toFixed(0)} KB`);
console.log(`  ${OUT}.json ${(fs.statSync(OUT + '.json').size / 1024).toFixed(0)} KB`);
if (skipped) console.log(`  ${skipped} foto(s) omitidas (sin archivo o ilegibles).`);
