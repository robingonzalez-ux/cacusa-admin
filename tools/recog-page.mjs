// Utilidad compartida por build-catalog-refs.mjs y eval-catalog-refs.mjs: abre Chromium
// headless con el MISMO código de reconocimiento del panel (el bloque entre
// "// @@recog-begin" y "// @@recog-end" de index.html, más productImageUrl) y el mismo
// TF.js 4.22.0 + MobileNet v2 de models/mobilenet_v2/, servidos desde un servidor local.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ADMIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SITE_ORIGIN = 'https://cacusabytaitus.com';
const TFJS_CDN = 'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js';

export function extractRecognitionCode() {
  const html = fs.readFileSync(path.join(ADMIN_DIR, 'index.html'), 'utf8');
  const a = html.indexOf('// @@recog-begin'), b = html.indexOf('// @@recog-end');
  if (a < 0 || b < a) throw new Error('No se encontró el bloque @@recog-begin/@@recog-end en index.html');
  const piu = html.match(/function productImageUrl\(p\) \{[\s\S]*?\n\}/);
  if (!piu) throw new Error('No se encontró productImageUrl en index.html');
  return piu[0] + '\n' + html.slice(a, b);
}

// siteDir: carpeta con data/products.json + ui_kits/store/images/... (copia local del sitio).
// extraJs: código adicional para la página (p. ej. las transformaciones de la evaluación).
export async function openRecognitionPage({ siteDir, tfjsFile, extraJs = '' }) {
  let chromium;
  try { ({ chromium } = await import('playwright')); }
  catch (_) { throw new Error('Falta Playwright: cd tools && npm install && npx playwright install chromium'); }
  const code = extractRecognitionCode();
  const page_html = `<!doctype html><meta charset="utf-8"><title>refs</title><body><script>${code}\n${extraJs}\nwindow.__ready = true;</script></body>`;
  const server = http.createServer((req, res) => {
    const u = decodeURIComponent(req.url.split('?')[0]);
    if (u === '/__recog.html') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(page_html); }
    let root = ADMIN_DIR, rel = u;
    if (u.startsWith('/__site/')) { root = siteDir; rel = u.slice('/__site'.length); }
    const f = path.join(root, rel);
    if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
    const ext = path.extname(f);
    const type = { '.json': 'application/json', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png' }[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type }); res.end(fs.readFileSync(f));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on('pageerror', e => console.error('pageerror:', e.message));
  // Las fotos del catálogo (https://cacusabytaitus.com/...) se sirven desde siteDir, con CORS,
  // para poder usar también las funciones del panel que las piden por URL pública.
  await page.route(SITE_ORIGIN + '/**', r => {
    const f = path.join(siteDir, decodeURIComponent(new URL(r.request().url()).pathname));
    if (!f.startsWith(siteDir) || !fs.existsSync(f)) return r.fulfill({ status: 404 });
    return r.fulfill({ status: 200, contentType: 'image/webp', headers: { 'Access-Control-Allow-Origin': '*' }, body: fs.readFileSync(f) });
  });
  if (tfjsFile) {
    await page.route(TFJS_CDN, r => r.fulfill({ status: 200, contentType: 'application/javascript', headers: { 'Access-Control-Allow-Origin': '*' }, body: fs.readFileSync(tfjsFile) }));
  }
  await page.goto(`http://127.0.0.1:${port}/__recog.html`);
  await page.waitForFunction(() => window.__ready === true);
  await page.evaluate(async () => { const eng = await loadRecognitionModel(); window.__backend = eng.tf.getBackend(); });
  const backend = await page.evaluate(() => window.__backend);
  return {
    page, backend,
    // URL pública del catálogo → ruta local servida (misma imagen, mismo origen).
    localUrl: url => '/__site' + new URL(url).pathname,
    async close() { await browser.close(); server.close(); },
  };
}

// Descarga data/products.json y todas las fotos del sitio público a dir (modo "en línea").
export async function downloadSite(dir) {
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  const get = async u => { const r = await fetch(u); if (!r.ok) throw new Error(`${r.status} ${u}`); return Buffer.from(await r.arrayBuffer()); };
  const buf = await get(SITE_ORIGIN + '/data/products.json');
  fs.writeFileSync(path.join(dir, 'data', 'products.json'), buf);
  const cat = JSON.parse(buf.toString('utf8'));
  for (const url of new Set(cat.products.flatMap(productUrls))) {
    const f = path.join(dir, new URL(url).pathname);
    if (fs.existsSync(f)) continue;
    fs.mkdirSync(path.dirname(f), { recursive: true });
    try { fs.writeFileSync(f, await get(url)); } catch (e) { console.warn('no se pudo bajar', url, e.message); }
  }
  return dir;
}
// Todas las fotos de un producto (la principal primero), solo https del sitio.
export function productUrls(p) {
  const list = [p && p.imageUrl, ...((p && Array.isArray(p.images)) ? p.images : [])];
  const out = [];
  for (const u of list) if (typeof u === 'string' && /^https:\/\//.test(u) && !out.includes(u)) out.push(u);
  return out;
}
