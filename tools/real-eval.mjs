// Modo --real de eval-catalog-refs.mjs (v2.4): evalúa las funciones REALES del panel con fotos reales
// etiquetadas. <dir>/labels.json = [{ "file": "a.jpg", "sku": "AN001" }, …] (rutas relativas a <dir>).
// Informa: acierto con 1 foto (total y por categoría), fusión de 2 fotos de la misma pieza, simulación
// de "foto real aprendida" (una foto de la pieza como referencia y la otra como consulta) y, con
// --tune, un barrido con las piezas separadas en 2 mitades por código (ajuste / prueba).
import fs from 'node:fs';
import path from 'node:path';

const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
const pct = (a, n) => (n ? (100 * a / n).toFixed(1) : '—') + ' %';

export async function runReal({ pg, catalog, dir, tune }) {
  const labels = JSON.parse(fs.readFileSync(path.join(dir, 'labels.json'), 'utf8'));
  const bySku = new Map(catalog.products.filter(p => p && p.sku).map(p => [String(p.sku).trim().toUpperCase(), p]));
  const photos = [];
  for (const l of labels) {
    const p = bySku.get(String(l.sku || '').trim().toUpperCase());
    const f = path.join(dir, l.file);
    if (!p) { console.warn('  código desconocido, se omite:', l.sku, l.file); continue; }
    if (!fs.existsSync(f)) { console.warn('  no existe:', l.file); continue; }
    photos.push({ file: l.file, sku: String(p.sku).toUpperCase(), id: String(p.id), category: p.category || '', src: `data:${MIME[path.extname(f).toLowerCase()] || 'image/jpeg'};base64,` + fs.readFileSync(f).toString('base64') });
  }
  const skus = [...new Set(photos.map(p => p.sku))];
  console.log(`\n== Fotos reales: ${photos.length} fotos de ${skus.length} piezas (${dir}) ==`);
  if (!photos.length) return;

  // Configuraciones de huella a probar (vistas de la pieza y parámetros de pieceBox).
  const embCfgs = [{ name: 'actual', views: null, box: null }];
  if (tune) {
    for (const floor of [12, 18, 26]) for (const [lo, hi] of [[0.03, 0.97], [0.08, 0.92]]) for (const pv of [[1.25, 1.6], [1.1, 1.4], [1.4, 1.9]]) {
      if (floor === 18 && lo === 0.03 && pv[0] === 1.25) continue;
      embCfgs.push({ name: `pieceBox piso ${floor}, ${lo}–${hi}, vistas ${pv.join('/')}`, views: [['c', 1], ['c', 0.8], ['c', 0.6], ['p', pv[0]], ['p', pv[1]]], box: { floor, lo, hi } });
    }
  }
  const out = await pg.evaluate(async ([photos, prods, embCfgs, tune]) => {
    const eng = await loadRecognitionModel();
    const cat = await prepareCatalogEmbeddings(prods);
    const split = sku => (strHash(sku) % 2 === 0 ? 'ajuste' : 'prueba');
    const imgs = []; for (const p of photos) imgs.push(await loadImg(p.src, false));
    const quality = imgs.map(img => { const q = photoQuality(img); return { dark: q.dark, blurry: q.blurry }; });
    const defBox = { ...PIECE_BOX };
    const embedAll = async cfg => { const out = []; for (const img of imgs) {
      Object.assign(PIECE_BOX, defBox, cfg.box || {});
      const e = cfg.views ? { ...eng, views: cfg.views } : eng;
      const base = { color: colorDescriptor(img), kind: eng.kind, cw: eng.cw, margin: eng.margin };
      if (eng.kind === 'v3') { const r3 = await embedV3Both(e, img, null); out.push({ ...base, emb: r3.all, embRef: r3.ref }); continue; }
      if (eng.kind !== 'v2') { out.push({ ...base, emb: await embedPhoto(eng, img, 'query') }); continue; }
      const r = rawV2Both(e, img, null);
      out.push({ ...base, emb: projectV2(eng.proj, r.all), embRef: projectV2(eng.proj, r.ref) });
    } return out; };
    const rankOf = (qs, id, category, refs) => {
      const r = rankCatalogMulti(qs, cat.items, refs || null, 'Todas', Infinity);
      const i = r.findIndex(x => String(x.p.id) === id);
      const rc = rankCatalogMulti(qs, cat.items, refs || null, category, Infinity).findIndex(x => String(x.p.id) === id) + 1;
      return { r: i + 1, rc, margin: r.length > 1 ? r[0].score - r[1].score : 1, wrong: String(r[0].p.id) !== id };
    };
    const res = [];
    for (const cfg of embCfgs) {
      const Q = await embedAll(cfg);
      const cws = cfg.name === 'actual' && tune ? [0, 0.05, 0.1, 0.15] : [eng.cw];
      for (const cw of cws) {
        const Qc = Q.map(q => ({ ...q, cw }));
        const single = photos.map((p, i) => ({ sku: p.sku, category: p.category, split: split(p.sku), ...rankOf([Qc[i]], p.id, p.category) }));
        const groups = {}; photos.forEach((p, i) => (groups[p.sku] ||= []).push(i));
        const pairs = [], learned = [];
        const margins = cfg.name === 'actual' && cw === eng.cw ? (tune ? [0, 0.1, 0.15, 0.21, 0.25, 0.3] : [LEARNED_MARGIN]) : [];
        // "todas con 1 foto real": cada pieza con ≥ 2 fotos aporta su 1ra foto como referencia aprendida
        const firstRef = {}; for (const [sku, ii] of Object.entries(groups)) if (ii.length >= 2) firstRef[photos[ii[0]].id] = ii[0];
        for (const [sku, ii] of Object.entries(groups)) {
          if (ii.length < 2) continue;
          for (let a = 0; a < ii.length; a++) for (let b = a + 1; b < ii.length && pairs.filter(x => x.sku === sku).length < 3; b++)
            pairs.push({ sku, split: split(sku), category: photos[ii[a]].category, ...rankOf([Qc[ii[a]], Qc[ii[b]]], photos[ii[a]].id, photos[ii[a]].category) });
          for (const m of margins) for (let a = 0; a < Math.min(ii.length, 3); a++) {
            const q = Qc[ii[a]], other = ii[(a + 1) % ii.length], id = photos[ii[a]].id;
            const only = prepareLearnedRefs({ [id]: [quantizeEmb(Q[other].embRef || Q[other].emb)] }, { m, mp: Math.max(0, m - 0.03) });
            const rawAll = {}; for (const [pid, k] of Object.entries(firstRef)) rawAll[pid] = [quantizeEmb(Q[pid === id ? other : k].embRef || Q[pid === id ? other : k].emb)];
            const all = prepareLearnedRefs(rawAll, { m, mp: Math.max(0, m - 0.03) });
            learned.push({ sku, split: split(sku), m, none: rankOf([q], id, '', null).r, only: rankOf([q], id, '', only).r, all: rankOf([q], id, '', all).r });
          }
        }
        res.push({ cfg: cfg.name, cw, single, pairs, learned });
      }
    }
    Object.assign(PIECE_BOX, defBox);
    return { res, quality, defCw: eng.cw, doubt: DOUBT_MARGIN, lm: LEARNED_MARGIN };
  }, [photos, catalog.products, embCfgs, !!tune]);

  const h1 = (rows, k = 'r') => rows.filter(x => x[k] === 1).length, h5 = (rows, k = 'r') => rows.filter(x => x[k] >= 1 && x[k] <= 5).length;
  const line = rows => `hit@1 ${pct(h1(rows), rows.length)} · hit@5 ${pct(h5(rows), rows.length)} · con categoría hit@1 ${pct(h1(rows, 'rc'), rows.length)} (n=${rows.length})`;
  const base = out.res.find(r => r.cfg === 'actual' && r.cw === out.defCw);
  const q = out.quality, nq = q.filter(x => x.dark || x.blurry).length;
  console.log(`  aviso de calidad: ${nq} de ${q.length} fotos (oscuras ${q.filter(x => x.dark).length}, movidas ${q.filter(x => x.blurry).length})`);
  console.log(`  1 foto:            ${line(base.single)}`);
  if (base.pairs.length) console.log(`  2 fotos (fusión):  ${line(base.pairs)}`);
  else console.log('  2 fotos: ninguna pieza tiene 2 fotos o más');
  const cats = [...new Set(base.single.map(x => x.category))].sort();
  for (const c of cats) console.log(`    ${(c || '(sin categoría)').padEnd(16)} ${line(base.single.filter(x => x.category === c))}`);
  const L = base.learned.filter(x => x.m === out.lm);
  if (L.length) console.log(`  foto real aprendida (margen ${out.lm}; otra foto de la pieza como referencia): sin ${pct(L.filter(x => x.none === 1).length, L.length)} · solo la correcta ${pct(L.filter(x => x.only === 1).length, L.length)} · todas con 1 foto real ${pct(L.filter(x => x.all === 1).length, L.length)} hit@1 (n=${L.length})`);
  const d = base.single.filter(x => x.margin < out.doubt), tp = d.filter(x => x.wrong).length, errs = base.single.filter(x => x.wrong).length;
  console.log(`  aviso de duda (margen < ${out.doubt}): ${d.length} avisos, precisión ${pct(tp, d.length)}, recall ${pct(tp, errs)} de ${errs} errores`);
  if (!tune) return;

  // ── Barrido: se elige con la mitad de ajuste y se informa la de prueba ──
  const sp = (rows, s) => rows.filter(x => x.split === s);
  const acc = rows => (rows.length ? h1(rows) / rows.length : 0);
  console.log('\n  -- Barrido (piezas en 2 mitades por código; se elige con "ajuste") --');
  const best = (cands, score) => cands.reduce((b, c) => (score(c) > score(b) ? c : b), cands[0]);
  const embC = out.res.filter(r => r.cw === out.defCw || r.cfg !== 'actual');
  const bE = best(embC, r => acc(sp(r.single, 'ajuste'))); // empate → se queda el actual (va 1ro)
  const ranked = [...embC].sort((a, b) => acc(sp(b.single, 'ajuste')) - acc(sp(a.single, 'ajuste'))).slice(0, 6);
  for (const r of [base, ...ranked.filter(r => r !== base)]) console.log(`  huella "${r.cfg}": ajuste ${pct(h1(sp(r.single, 'ajuste')), sp(r.single, 'ajuste').length)} · prueba ${pct(h1(sp(r.single, 'prueba')), sp(r.single, 'prueba').length)} hit@1`);
  const cwC = out.res.filter(r => r.cfg === 'actual').sort((a, b) => (a.cw === out.defCw ? -1 : b.cw === out.defCw ? 1 : a.cw - b.cw)); // empate → se queda el actual
  for (const r of cwC) console.log(`  peso del color ${r.cw}: ajuste ${pct(h1(sp(r.single, 'ajuste')), sp(r.single, 'ajuste').length)} · prueba ${pct(h1(sp(r.single, 'prueba')), sp(r.single, 'prueba').length)}`);
  console.log(`  → mejor huella en ajuste: "${bE.cfg}"; mejor color: ${best(cwC, r => acc(sp(r.single, 'ajuste'))).cw}`);
  for (const t of [0.02, 0.03, 0.04, 0.05, 0.06]) {
    const f = s => { const rows = sp(base.single, s), al = rows.filter(x => x.margin < t), tp = al.filter(x => x.wrong).length, e = rows.filter(x => x.wrong).length; return `avisos ${al.length}/${rows.length}, precisión ${pct(tp, al.length)}, recall ${pct(tp, e)}`; };
    console.log(`  duda < ${t}: ajuste ${f('ajuste')} | prueba ${f('prueba')}`);
  }
  const ms = [...new Set(base.learned.map(x => x.m))];
  for (const m of ms) {
    const f = s => { const rows = base.learned.filter(x => x.m === m && x.split === s); return rows.length ? `sin ${pct(rows.filter(x => x.none === 1).length, rows.length)} · solo la correcta ${pct(rows.filter(x => x.only === 1).length, rows.length)} · todas ${pct(rows.filter(x => x.all === 1).length, rows.length)}` : '—'; };
    console.log(`  margen de fotos reales ${m}: ajuste ${f('ajuste')} | prueba ${f('prueba')}`);
  }
}

// ── Piezas nuevas (--real <dir> --new, v2.5) ──
// Para piezas que NO están en el catálogo (código desconocido en labels.json; opcional "category"):
// cada pieza necesita ≥ 2 fotos. Inscripción simulada: la foto 1 entra como foto del catálogo por el
// MISMO camino que una foto nueva en el panel (se comprime como compressImage: 900 px WebP 0,82; se
// sirve por URL y prepareCatalogEmbeddings le calcula las variantes en vivo), junto con el catálogo
// y las demás piezas nuevas; se busca con la foto 2 (como photoToJpegBase64: 1024 px JPEG 0,82) y
// después al revés. "No registrada": la misma búsqueda sin la propia pieza en el catálogo.
export async function runNewPieces({ pg, catalog, dir, SITE_ORIGIN, dump }) {
  const labels = JSON.parse(fs.readFileSync(path.join(dir, 'labels.json'), 'utf8'));
  const known = new Set(catalog.products.filter(p => p && p.sku).map(p => String(p.sku).trim().toUpperCase()));
  const groups = new Map();
  for (const l of labels) {
    const sku = String(l.sku || '').trim();
    if (!sku || known.has(sku.toUpperCase())) continue;
    const f = path.join(dir, l.file);
    if (!fs.existsSync(f)) { console.warn('  no existe:', l.file); continue; }
    if (!groups.has(sku)) groups.set(sku, { sku, category: l.category || '', files: [] });
    groups.get(sku).files.push({ file: l.file, src: `data:${MIME[path.extname(f).toLowerCase()] || 'image/jpeg'};base64,` + fs.readFileSync(f).toString('base64') });
  }
  const items = [...groups.values()].filter(g => g.files.length >= 2);
  console.log(`\n== Piezas nuevas: ${items.length} piezas con 2 fotos o más (${dir}) ==`);
  if (!items.length) return;
  // Fotos procesadas como en el panel (catálogo: 900 px WebP; consulta: 1024 px JPEG).
  const proc = await pg.evaluate(async items => {
    const conv = async (src, maxPx, type, q) => {
      const img = await loadImg(src, false);
      let w = img.naturalWidth, h = img.naturalHeight;
      if (w > maxPx || h > maxPx) { if (w >= h) { h = Math.round(h * maxPx / w); w = maxPx; } else { w = Math.round(w * maxPx / h); h = maxPx; } }
      const cv = document.createElement('canvas'); cv.width = w; cv.height = h; cv.getContext('2d').drawImage(img, 0, 0, w, h);
      return cv.toDataURL(type, q);
    };
    const out = [];
    for (const it of items) { const fs = []; for (const f of it.files) fs.push({ cat: await conv(f.src, 900, 'image/webp', 0.82), query: await conv(f.src, 1024, 'image/jpeg', 0.82) }); out.push(fs); }
    return out;
  }, items);
  const served = new Map();
  await pg.route(SITE_ORIGIN + '/__new/**', r => {
    const b = served.get(new URL(r.request().url()).pathname);
    return b ? r.fulfill({ status: 200, contentType: 'image/webp', headers: { 'Access-Control-Allow-Origin': '*' }, body: b }) : r.fulfill({ status: 404 });
  });
  const rows = [];
  for (const role of [0, 1]) { // 0: se inscribe la foto 1 y se busca con la 2; 1: al revés
    const newProds = items.map((it, i) => {
      const p = `/__new/${encodeURIComponent(it.sku)}-${role}.webp`;
      served.set(p, Buffer.from(proc[i][role].cat.split(',')[1], 'base64'));
      return { id: 'new:' + it.sku, sku: it.sku, name: it.sku, category: it.category, imageUrl: SITE_ORIGIN + p, available: true };
    });
    const r = await pg.evaluate(async ([prods, queries]) => {
      const cat = await prepareCatalogEmbeddings(prods);
      const out = [];
      for (const q0 of queries) {
        const q = await embedQueryPhoto(q0.src);
        const all = rankCatalog(q, cat.items, null, 'Todas', Infinity);
        const i = all.findIndex(x => String(x.p.id) === q0.id);
        const inCat = rankCatalog(q, cat.items, null, q0.category || 'Todas', Infinity).findIndex(x => String(x.p.id) === q0.id) + 1;
        const open = all.filter(x => String(x.p.id) !== q0.id); // la pieza todavía no está registrada
        out.push({ ...q0, src: undefined, r: i + 1, rc: inCat, top: String(all[0].p.sku || all[0].p.id), score: all[0].score, margin: all[0].score - all[1].score,
                   openTop: String(open[0].p.sku || open[0].p.id), openScore: open[0].score, openMargin: open[0].score - open[1].score });
      }
      return out;
    }, [[...catalog.products, ...newProds], items.map((it, i) => ({ sku: it.sku, id: 'new:' + it.sku, category: it.category, k: 1 - role, file: it.files[1 - role].file, src: proc[i][1 - role].query }))]);
    rows.push(...r.map(x => ({ ...x, enrolled: role, queryPhoto: 1 - role })));
  }
  const n = rows.length, h = f => rows.filter(f).length;
  console.log(`  inscripción simulada (foto del catálogo = la otra foto; ${n} búsquedas): hit@1 ${pct(h(x => x.r === 1), n)} · hit@5 ${pct(h(x => x.r >= 1 && x.r <= 5), n)} · dentro de la categoría hit@1 ${pct(h(x => x.rc === 1), n)}`);
  for (const k of [1, 0]) { const s = rows.filter(x => x.queryPhoto === k); console.log(`    buscando con la foto ${k + 1} (inscrita la ${2 - k}): hit@1 ${pct(s.filter(x => x.r === 1).length, s.length)} · hit@5 ${pct(s.filter(x => x.r >= 1 && x.r <= 5).length, s.length)} (n=${s.length})`); }
  for (const x of rows.filter(x => x.r !== 1)) console.log(`    confusión: ${x.sku} (foto ${x.queryPhoto + 1}) → ${x.top}, la correcta en el puesto ${x.r}`);
  const ok = rows.filter(x => x.r === 1);
  const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(3) : '—'; };
  const sc = a => `p10 ${q(a, 0.1)} · mediana ${q(a, 0.5)} · p90 ${q(a, 0.9)}`;
  console.log(`  "no registrada" — puntaje del 1ro: aciertos ${sc(ok.map(x => x.score))} | piezas no registradas ${sc(rows.map(x => x.openScore))}`);
  console.log(`                    margen 1ro − 2do: aciertos ${sc(ok.map(x => x.margin))} | piezas no registradas ${sc(rows.map(x => x.openMargin))}`);
  if (dump) fs.writeFileSync(dump, JSON.stringify(rows.map(({ src, ...x }) => x)));
}
