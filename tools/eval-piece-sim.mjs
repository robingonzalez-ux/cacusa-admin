#!/usr/bin/env node
// Evaluación de la similitud SOLO DE LA PIEZA (28 nov; ver README "Similitud solo de la pieza") contra la
// huella de la foto entera, con las funciones reales del panel (embedV3Both, embedPiece, galleryRefMask).
//
//   node eval-piece-sim.mjs --site <copia local del sitio> [--tfjs tf.min.js] [--cache c.json] [--real <carpeta>]
//
// Calcula (y guarda en --cache) para cada foto de producto la huella de la foto entera y la de la pieza,
// y además:
//   · cambio de fondo: las piezas de las fotos con fondo blanco, recortadas y pegadas sobre otros fondos
//     (plantilla beige con logo, otra plantilla, bandeja gris con el cartel rosado —la pieza chica, como
//     en las fotos reales, o grande—, terciopelo, cartel rosado); los fondos salen de fotos del catálogo
//     con la pieza borrada (relleno por difusión). Misma pieza en otro fondo vs en blanco, y distintas
//     piezas sobre el mismo fondo.
//   · fotos "del taller" sintéticas (makeTestPhoto A y B de eval-transforms.js) de cada producto.
//   · --real <carpeta>: fotos reales de piezas que NO están en el catálogo (<carpeta>/labels.json =
//     [{file, sku}]); solo como negativos del aviso "¿ya existe?". Las fotos no se copian a ningún lado.
// Informa: pares de los grupos de mismo fondo (bandeja, plantillas, busto), pares puntuales, misma pieza
// en otra foto, cambio de fondo, gemelas con TWIN_MIN, y la tabla del aviso "¿ya existe?" / "Sugerir
// datos" por umbral con los productos separados en 2 mitades por código (ajuste / prueba).
import fs from 'node:fs';
import path from 'node:path';
import { ADMIN_DIR, openRecognitionPage, productUrls, loadGalleryRule, extractRecognitionCode } from './recog-page.mjs';

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf('--' + name); return i >= 0 ? (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true) : def; };
const siteDir = path.resolve(opt('site', ''));
const CACHE = opt('cache', null), REAL = opt('real', null);
const catalog = JSON.parse(fs.readFileSync(path.join(siteDir, 'data', 'products.json'), 'utf8'));
const code = extractRecognitionCode();
const num = name => Number((code.match(new RegExp('const ' + name + ' = ([0-9.]+)')) || [])[1]);
const html = fs.readFileSync(path.join(ADMIN_DIR, 'index.html'), 'utf8');
const hnum = name => Number((html.match(new RegExp('\\b' + name + ' = ([0-9.]+)')) || [])[1]);
const TWIN_MIN = num('TWIN_MIN'), SUGGEST_MIN = num('SUGGEST_MIN'), SUGGEST_GAP = num('SUGGEST_GAP'), DUP_HIGH = hnum('DUP_HIGH'), DUP_MEDIUM = hnum('DUP_MEDIUM');
const bySku = Object.fromEntries(catalog.products.filter(p => p.sku).map(p => [p.sku, p]));

let data = CACHE && fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE, 'utf8')) : { photos: {}, swap: {}, ab: {}, real: {} };
const save = () => CACHE && fs.writeFileSync(CACHE, JSON.stringify(data));
const helpers = fs.readFileSync(path.join(ADMIN_DIR, 'tools', 'eval-transforms.js'), 'utf8') + `
function __b64(v) { const u = new Uint8Array(Float32Array.from(v).buffer); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); }
async function __both(img) {
  const eng = await loadRecognitionModel(), D = eng.proj.dOut + eng.dino.proj.dOut;
  const all = (await embedV3Both(eng, img, null)).all, pc = await embedPiece(eng, img);
  return { all: __b64(all.subarray(0, D)), piece: pc.emb ? __b64(pc.emb.subarray(0, D)) : null, ok: pc.ok, prop: pc.prop };
}
// Pieza recortada (RGBA, fondo transparente) de una foto limpia.
async function __cut(img) {
  const eng = await loadRecognitionModel(), w = img.naturalWidth, h = img.naturalHeight, cv = cropRect(img, 0, 0, w, h, 800);
  const u = await segSaliency(eng, cv), e = segRegion(u), N = u.N;
  const mc = document.createElement('canvas'); mc.width = N; mc.height = N; const mi = mc.getContext('2d').createImageData(N, N);
  for (let p = 0; p < N * N; p++) mi.data[p * 4 + 3] = e.inMask(p) ? Math.round(255 * u.prob[p]) : 0;
  mc.getContext('2d').putImageData(mi, 0, 0);
  const fg = document.createElement('canvas'); fg.width = cv.width; fg.height = cv.height; const f = fg.getContext('2d');
  f.drawImage(cv, 0, 0); f.globalCompositeOperation = 'destination-in'; f.drawImage(mc, 0, 0, cv.width, cv.height);
  const x0 = e.x0 * cv.width, y0 = e.y0 * cv.height, bw = (e.x1 - e.x0) * cv.width, bh = (e.y1 - e.y0) * cv.height;
  const out = document.createElement('canvas'); out.width = Math.round(bw); out.height = Math.round(bh); out.getContext('2d').drawImage(fg, x0, y0, bw, bh, 0, 0, out.width, out.height);
  return { out, u, e };
}
// Borra zonas de una foto (máscara M a 1/4 de resolución) rellenándolas por difusión.
function __inpaint(img, markFn) {
  const w = img.naturalWidth, h = img.naturalHeight, k = 800 / Math.max(w, h), W = Math.round(w * k), H = Math.round(h * k);
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H; const ctx = cv.getContext('2d'); ctx.drawImage(img, 0, 0, W, H);
  const s = 4, w2 = Math.ceil(W / s), h2 = Math.ceil(H / s), sm = document.createElement('canvas'); sm.width = w2; sm.height = h2;
  const sctx = sm.getContext('2d'); sctx.drawImage(cv, 0, 0, w2, h2);
  const im = sctx.getImageData(0, 0, w2, h2), d = im.data, M = new Uint8Array(w2 * h2); markFn(M, w2, h2);
  const f = Float32Array.from(d);
  for (let it = 0; it < 400; it++) for (let y = 0; y < h2; y++) for (let x = 0; x < w2; x++) { const p = y * w2 + x; if (!M[p]) continue; for (let c = 0; c < 3; c++) { let sum = 0, n = 0; for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const xx = x + dx, yy = y + dy; if (xx >= 0 && yy >= 0 && xx < w2 && yy < h2) { sum += f[(yy * w2 + xx) * 4 + c]; n++; } } f[p * 4 + c] = sum / n; } }
  for (let i = 0; i < d.length; i++) d[i] = f[i]; sctx.putImageData(im, 0, 0);
  const big = document.createElement('canvas'); big.width = W; big.height = H; big.getContext('2d').drawImage(sm, 0, 0, W, H);
  const A = ctx.getImageData(0, 0, W, H), B = big.getContext('2d').getImageData(0, 0, W, H), R = mulberry32(7);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { if (!M[Math.min(h2 - 1, (y / s) | 0) * w2 + Math.min(w2 - 1, (x / s) | 0)]) continue; const i = (y * W + x) * 4, n = (R() - 0.5) * 6; for (let c = 0; c < 3; c++) A.data[i + c] = B.data[i + c] + n; }
  ctx.putImageData(A, 0, 0); return cv;
}
function __markSal(u, e, maxY) { return (M, w2, h2) => { for (let y = 0; y < h2; y++) for (let x = 0; x < w2; x++) { for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) { const xx = Math.floor((x + dx) / w2 * u.N), yy = Math.floor((y + dy) / h2 * u.N); if (xx >= 0 && yy >= 0 && xx < u.N && yy < u.N && yy < u.N * maxY && u.prob[yy * u.N + xx] > 0.2) { M[y * w2 + x] = 1; dy = dx = 9; } } } }; }
async function __bgs(tpl, tpl2, tray, pink) {
  const eng = await loadRecognitionModel(), L = s => loadImg(s, false);
  const T = await L(tpl), uT = await segSaliency(eng, cropRect(T, 0, 0, T.naturalWidth, T.naturalHeight, 640));
  const T2 = await L(tpl2), uT2 = await segSaliency(eng, cropRect(T2, 0, 0, T2.naturalWidth, T2.naturalHeight, 640));
  const Y = await L(tray), pc = await pieceCanvas(eng, Y), b = pc.box, W = Y.naturalWidth, H = Y.naturalHeight, pad = 0.03;
  const P = await L(pink), pk = document.createElement('canvas'); pk.width = 800; pk.height = 600; pk.getContext('2d').drawImage(P, 0, P.naturalHeight * 0.58, P.naturalWidth, P.naturalHeight * 0.42, 0, 0, 800, 600);
  const vel = document.createElement('canvas'); vel.width = 800; vel.height = 800; { const R = mulberry32(7), c = vel.getContext('2d'), im = c.createImageData(800, 800), d = im.data; for (let y = 0; y < 800; y++) for (let x = 0; x < 800; x++) { const v = 1 + 0.5 * Math.exp(-(((x - 320) ** 2 + (y - 240) ** 2) / (800 * 800 * 0.12))) + (R() - 0.5) * 0.25, i = (y * 800 + x) * 4; d[i] = 40 * v; d[i + 1] = 22 * v; d[i + 2] = 48 * v; d[i + 3] = 255; } c.putImageData(im, 0, 0); }
  const wh = document.createElement('canvas'); wh.width = 800; wh.height = 800; { const c = wh.getContext('2d'); c.fillStyle = '#fff'; c.fillRect(0, 0, 800, 800); }
  const ring = [(b[0] + b[2]) / 2 / W, (b[1] + b[3]) / 2 / H], trayBg = __inpaint(Y, (M, w2, h2) => { for (let y = Math.floor((b[1] / H - pad) * h2); y < Math.ceil((b[3] / H + pad) * h2); y++) for (let x = Math.floor((b[0] / W - pad) * w2); x < Math.ceil((b[2] / W + pad) * w2); x++) if (x >= 0 && y >= 0 && x < w2 && y < h2) M[y * w2 + x] = 1; });
  window.__BG = { white: [wh, 0.5, 0.5, 0.6], plantilla: [__inpaint(T, __markSal(uT, null, 0.8)), 0.5, 0.5, 0.55], plantilla2: [__inpaint(T2, __markSal(uT2, null, 0.62)), 0.5, 0.4, 0.45],
    'bandeja-chica': [trayBg, ring[0], ring[1], 0.14], 'bandeja-grande': [trayBg, 0.45, 0.4, 0.42], terciopelo: [vel, 0.5, 0.5, 0.55], 'cartel-rosado': [pk, 0.5, 0.5, 0.5] };
  return Object.keys(window.__BG);
}
async function __swap(src, bg) {
  const img = await loadImg(src, false); window.__FG = window.__FG || {}; const fg = window.__FG[src] || (window.__FG[src] = (await __cut(img)).out);
  const [B, cx, cy, size] = window.__BG[bg], cv = document.createElement('canvas'); cv.width = B.width; cv.height = B.height; const ctx = cv.getContext('2d'); ctx.drawImage(B, 0, 0);
  const S = Math.min(B.width, B.height) * size, k = S / Math.max(fg.width, fg.height), w = fg.width * k, h = fg.height * k;
  ctx.shadowColor = 'rgba(0,0,0,0.25)'; ctx.shadowBlur = 10; ctx.shadowOffsetX = 3; ctx.shadowOffsetY = 5; ctx.drawImage(fg, cx * B.width - w / 2, cy * B.height - h / 2, w, h);
  return __both(cv);
}`;
let rp = null;
const page = async () => (rp ||= await openRecognitionPage({ siteDir, tfjsFile: opt('tfjs', null), extraJs: helpers }));
const t0 = Date.now(), secs = () => ((Date.now() - t0) / 1000).toFixed(0) + ' s';
// 1) fotos del catálogo
const prods = catalog.products.filter(p => p && p.sku && p.available !== false && productUrls(p).length);
for (const [i, p] of prods.entries()) for (const url of productUrls(p)) {
  if (data.photos[url]) continue;
  const { page: pg, localUrl } = await page();
  data.photos[url] = await pg.evaluate(async src => { const img = await loadImg(src, false); return { ...(await __both(img)), bu: borderUniformity(img) }; }, localUrl(url));
  if (i % 5 === 0) { save(); process.stdout.write(`\r  fotos del catálogo: ${i + 1}/${prods.length} productos · ${secs()}  `); }
}
save();
// 2) cambio de fondo: piezas de fotos con fondo blanco
const isWhite = p => { const r = data.photos[productUrls(p)[0]]; return r && r.bu >= 0.9 && r.white; };
for (const p of prods) { const r = data.photos[productUrls(p)[0]]; if (r && r.white === undefined) { const { page: pg, localUrl } = await page(); r.white = await pg.evaluate(async src => { const img = await loadImg(src, false), N = 64, cv = document.createElement('canvas'); cv.width = N; cv.height = N; const c = cv.getContext('2d'); c.drawImage(img, 0, 0, N, N); const d = c.getImageData(0, 0, N, N).data; let s = 0, k = 0; for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) { if (x > 2 && x < N - 3 && y > 2 && y < N - 3) continue; const i = (y * N + x) * 4; s += Math.min(d[i], d[i + 1], d[i + 2]); k++; } return s / k >= 225; }, localUrl(productUrls(p)[0])); } }
const whites = prods.filter(isWhite).map(p => p.sku);
const BGS = ['white', 'plantilla', 'plantilla2', 'bandeja-chica', 'bandeja-grande', 'terciopelo', 'cartel-rosado'];
const bgSrc = ['AN023', 'AR004', 'AN006', 'AN010'].map(s => bySku[s]);
if (bgSrc.every(Boolean) && whites.some(s => BGS.some(bg => !data.swap[s + '|' + bg]))) {
  const { page: pg, localUrl } = await page();
  await pg.evaluate(a => __bgs(...a), bgSrc.map(p => localUrl(productUrls(p)[0])));
  for (const s of whites) for (const bg of BGS) if (!data.swap[s + '|' + bg]) data.swap[s + '|' + bg] = await pg.evaluate(([src, bg]) => __swap(src, bg), [localUrl(productUrls(bySku[s])[0]), bg]);
  save(); console.log(`\n  cambio de fondo: ${whites.length} piezas × ${BGS.length} fondos · ${secs()}`);
}
// 3) fotos del taller sintéticas
for (const p of prods) for (const mode of ['A', 'B']) {
  const k = p.sku + '|' + mode; if (data.ab[k]) continue;
  const { page: pg, localUrl } = await page();
  data.ab[k] = await pg.evaluate(async ([src, id, mode]) => { const img = await loadImg(src, false); return __both(await loadImg(makeTestPhoto(img, strHash('eval|' + id + '|' + mode), mode), false)); }, [localUrl(productUrls(p)[0]), String(p.id), mode]);
}
save();
// 4) fotos reales de piezas nuevas (solo negativos; no se guardan las fotos, solo sus huellas en la caché local)
if (REAL) {
  const labels = JSON.parse(fs.readFileSync(path.join(REAL, 'labels.json'), 'utf8'));
  for (const l of labels) {
    if (data.real[l.file]) continue;
    const { page: pg } = await page();
    const src = 'data:image/jpeg;base64,' + fs.readFileSync(path.join(REAL, l.file)).toString('base64');
    data.real[l.file] = { ...(await pg.evaluate(async src => __both(await loadImg(src, false)), src)), sku: l.sku };
  }
  save();
}
if (rp) await rp.close();

// ── Análisis ──
const f32 = b => { const u = Buffer.from(b, 'base64'); return new Float32Array(u.buffer.slice(u.byteOffset, u.byteOffset + u.length)); };
const l2 = v => { let s = 0; for (const x of v) s += x * x; s = Math.sqrt(s) || 1; return Float32Array.from(v, x => x / s); };
const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
const V = (r, m) => !r ? null : m === 'all' ? (r._a ||= l2(f32(r.all))) : (r.ok && r.piece ? (r._p ||= l2(f32(r.piece))) : null);
const strHash = str => { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
const { galleryRefMask } = loadGalleryRule();
const P = {};
for (const p of prods) {
  const urls = productUrls(p).filter(u => data.photos[u]);
  const mask = galleryRefMask(urls.map(u => ({ emb: V(data.photos[u], 'all'), bu: data.photos[u].bu })));
  P[p.sku] = { p, keep: urls.filter((_, k) => mask[k].keep), anchor: urls[Math.max(0, mask.findIndex(x => x.anchor))] };
}
const M = ['all', 'piece'], LBL = { all: 'foto entera', piece: 'solo pieza' };
const sim = (a, b, m) => { const x = P[a] && V(data.photos[P[a].anchor], m), y = P[b] && V(data.photos[P[b].anchor], m); return x && y ? dot(x, y) : NaN; };
const f = x => (isNaN(x) ? '  —  ' : x.toFixed(3));
const pairs = l => { const o = []; for (let i = 0; i < l.length; i++) for (let j = i + 1; j < l.length; j++) if (P[l[i]] && P[l[j]]) o.push([l[i], l[j]]); return o; };
const stat = (ps, m, t) => { const v = ps.map(([a, b]) => sim(a, b, m)).filter(x => !isNaN(x)); return v.length ? `máx ${f(Math.max(...v))} · media ${f(v.reduce((s, x) => s + x, 0) / v.length)} · ≥ TWIN_MIN ${v.filter(x => x >= t).length}/${ps.length}` : `sin pieza aislada (0/${ps.length} pares comparables)`; };
console.log(`\nUmbrales del panel: TWIN_MIN ${TWIN_MIN} · SUGGEST_MIN ${SUGGEST_MIN} / GAP ${SUGGEST_GAP} · DUP_HIGH ${DUP_HIGH} / DUP_MEDIUM ${DUP_MEDIUM}`);
const groups = {
  'bandeja (AN006, AN007, AN008, AN010, AN012, AN013)': ['AN006', 'AN007', 'AN008', 'AN010', 'AN012', 'AN013'],
  'plantilla AN021–AN027 + AR003–AR006': ['AN021', 'AN022', 'AN023', 'AN024', 'AN025', 'AN026', 'AN027', 'AR003', 'AR004', 'AR005', 'AR006'],
  'busto CA010–CA017': ['CA010', 'CA011', 'CA012', 'CA013', 'CA014', 'CA015', 'CA016', 'CA017'],
};
for (const [g, l] of Object.entries(groups)) { console.log(`\n${g} — pares de piezas distintas con el mismo fondo`); for (const m of M) console.log(`  ${LBL[m].padEnd(11)} ${stat(pairs(l), m, TWIN_MIN)}`); }
console.log('\nPares puntuales (coseno entre fotos ancla)');
for (const [a, b] of [['AN023', 'AN025'], ['AN021', 'AN026'], ['AN006', 'AN008'], ['AN010', 'AN013'], ['AN031', 'AN033'], ['AN032', 'AN033'], ['AN032', 'AN003'], ['CA012', 'CA013']]) console.log(`  ${a}–${b}  ` + M.map(m => `${LBL[m]} ${f(sim(a, b, m))}`).join('  '));
console.log('\nMisma pieza, otra foto coherente vs la ancla');
for (const m of M) { const v = []; for (const s of Object.keys(P)) for (const u of P[s].keep) { const a = V(data.photos[u], m), b = V(data.photos[P[s].anchor], m); if (u !== P[s].anchor && a && b) v.push(dot(a, b)); } v.sort((a, b) => a - b); console.log(`  ${LBL[m].padEnd(11)} n=${v.length} mín ${f(v[0])} · p10 ${f(v[Math.floor(v.length * 0.1)])} · mediana ${f(v[v.length >> 1])}`); }
const sk = whites.filter(s => data.swap[s + '|white']);
if (sk.length) {
  console.log(`\nCambio de fondo (${sk.length} piezas de fondo blanco). misma = misma pieza en ese fondo vs en blanco; distintas = 2 piezas distintas en ese fondo`);
  const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
  for (const bg of BGS.slice(1)) for (const m of M) {
    const same = sk.map(s => { const a = V(data.swap[s + '|' + bg], m), b = V(data.swap[s + '|white'], m); return a && b ? dot(a, b) : NaN; });
    const diff = []; for (let i = 0; i < sk.length; i++) for (let j = i + 1; j < sk.length; j++) { const a = V(data.swap[sk[i] + '|' + bg], m), b = V(data.swap[sk[j] + '|' + bg], m); if (a && b) diff.push(dot(a, b)); }
    const sv = same.filter(x => !isNaN(x));
    console.log(`  ${bg.padEnd(15)} ${LBL[m].padEnd(11)} misma: media ${f(mean(sv))} mín ${f(Math.min(...sv))} (sin aislar ${same.length - sv.length}) | distintas: media ${f(mean(diff))} máx ${f(Math.max(...diff))} · ≥ TWIN_MIN ${diff.filter(x => x >= TWIN_MIN).length}/${diff.length}`);
  }
}
for (const m of M) {
  const t = []; for (const [a, b] of pairs(Object.keys(P))) { const s = sim(a, b, m); if (s >= TWIN_MIN) t.push(`${a}–${b} ${s.toFixed(2)}`); }
  console.log(`\nGemelas con ${LBL[m]} (≥ ${TWIN_MIN}): ${t.length} pares${t.length ? ': ' + t.join(', ') : ''}`);
}
// "¿ya existe?" / "Sugerir datos": puntaje del 1ro (mejor foto de referencia del producto).
const refsOf = (s, m, excl) => P[s].keep.filter(u => u !== excl).map(u => V(data.photos[u], m)).filter(Boolean);
const rank = (q, m, truth, skip, excl) => { let best = -2, bs = null; for (const s of Object.keys(P)) { if (s === skip) continue; for (const r of refsOf(s, m, s === truth ? excl : null)) { const v = dot(q, r); if (v > best) { best = v; bs = s; } } } return [best, bs]; };
// Foto nueva (consulta): su huella de pieza se usa aunque no se haya podido aislar (como el panel).
const QV = (r, m) => (m === 'all' ? V(r, 'all') : r.piece ? l2(f32(r.piece)) : null);
const split = s => (strHash(String(s)) % 2 === 0 ? 'ajuste' : 'prueba');
for (const m of M) {
  const rows = [];
  for (const [k, r] of Object.entries(data.ab)) { const [s] = k.split('|'); const q = QV(r, m); if (!q || !P[s]) continue; const [top, bs] = rank(q, m, s); rows.push({ pos: true, src: 'sint', top, ok: bs === s, sp: split(s) }); }
  for (const s of Object.keys(P)) for (const u of P[s].keep) { if (u === P[s].anchor || !refsOf(s, m, u).length) continue; const q = V(data.photos[u], m); if (!q) continue; const [top, bs] = rank(q, m, s, null, u); rows.push({ pos: true, src: 'otra', top, ok: bs === s, sp: split(s) }); }
  for (const [, r] of Object.entries(data.real)) { const q = QV(r, m); if (!q) continue; const [top] = rank(q, m); rows.push({ pos: false, src: 'real', top, sp: split(r.sku) }); }
  for (const s of Object.keys(P)) { const q = V(data.photos[P[s].anchor], m); if (!q) continue; const [top] = rank(q, m, null, s); rows.push({ pos: false, src: 'loo', top, sp: split(s) }); }
  console.log(`\n"¿ya existe?" con ${LBL[m]} — detecta = el 1ro es la pieza correcta y pasa el umbral (fotos del taller sintéticas + otra foto del producto);`);
  console.log(`  falsa alarma = piezas nuevas reales (vs catálogo) y cada producto contra el catálogo sin él; precisión = avisos correctos / avisos`);
  for (const sp of ['ajuste', 'prueba']) {
    const R = rows.filter(r => r.sp === sp), pos = R.filter(r => r.pos), nr = R.filter(r => r.src === 'real'), nl = R.filter(r => r.src === 'loo');
    const pct = (a, b) => (b ? (100 * a / b).toFixed(0) + ' %' : '—');
    console.log(`  mitad de ${sp} (pos ${pos.length}, reales ${nr.length}, sin ella ${nl.length})`);
    for (const t of [...new Set([0.4, 0.45, 0.5, 0.55, 0.6, DUP_MEDIUM, DUP_HIGH, 0.7])].sort((a, b) => a - b)) { const al = R.filter(r => r.top >= t); console.log(`    ≥ ${t.toFixed(2)}: detecta ${pct(pos.filter(r => r.top >= t && r.ok).length, pos.length)} · falsa alarma reales ${pct(nr.filter(r => r.top >= t).length, nr.length)} · sin ella ${pct(nl.filter(r => r.top >= t).length, nl.length)} · precisión ${pct(al.filter(r => r.pos && r.ok).length, al.length)}`); }
  }
}
