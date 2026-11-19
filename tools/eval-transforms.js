// Transformaciones SOLO de evaluación (eval-catalog-refs.mjs). A propósito distintas de las
// de entrenamiento (augmentPhoto): fondos con textura (madera, tela a cuadros, mármol,
// granito), pieza chica y descentrada (40–50 % del lado corto), giro de hasta 25°, sombra,
// luz mezclada en degradé (cálida→fría / fluorescente verdosa), dedo tapando una parte,
// recortes parciales de la pieza, formato no cuadrado y JPEG calidad 60.
function evalTexture(ctx, W, H, R, kind) {
  const rnd = (a, b) => a + (b - a) * R();
  if (kind === 0) { // madera
    const base = ['#8B5E3C', '#A0703F', '#6E4B2A', '#B8875A'][Math.floor(R() * 4)];
    ctx.fillStyle = base; ctx.fillRect(0, 0, W, H);
    for (let i = 0; i < 90; i++) {
      const y0 = R() * H, amp = rnd(2, 10), per = rnd(80, 300);
      ctx.strokeStyle = R() < 0.5 ? `rgba(40,20,5,${rnd(0.05, 0.22)})` : `rgba(255,230,190,${rnd(0.04, 0.12)})`;
      ctx.lineWidth = rnd(1, 4); ctx.beginPath();
      for (let x = 0; x <= W; x += 10) { const y = y0 + Math.sin(x / per * 6.28 + i) * amp; x ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
      ctx.stroke();
    }
  } else if (kind === 1) { // tela a cuadros
    const c1 = ['#E9D8C4', '#C8D6E5', '#E5C8D0', '#D6E2C8'][Math.floor(R() * 4)], c2 = 'rgba(80,60,90,0.18)';
    ctx.fillStyle = c1; ctx.fillRect(0, 0, W, H);
    const st = Math.round(rnd(16, 34));
    ctx.fillStyle = c2;
    for (let x = 0; x < W; x += st * 2) ctx.fillRect(x, 0, st, H);
    for (let y = 0; y < H; y += st * 2) ctx.fillRect(0, y, W, st);
  } else if (kind === 2) { // mármol
    ctx.fillStyle = '#EEEDEA'; ctx.fillRect(0, 0, W, H);
    for (let i = 0; i < 14; i++) {
      ctx.strokeStyle = `rgba(90,90,100,${rnd(0.08, 0.3)})`; ctx.lineWidth = rnd(0.6, 3);
      ctx.beginPath(); ctx.moveTo(R() * W, 0);
      ctx.bezierCurveTo(R() * W, R() * H, R() * W, R() * H, R() * W, H); ctx.stroke();
    }
  } else { // granito / cemento
    ctx.fillStyle = ['#8E8E8E', '#6F6A66', '#B5B0A8'][Math.floor(R() * 3)]; ctx.fillRect(0, 0, W, H);
    const im = ctx.getImageData(0, 0, W, H), d = im.data;
    for (let i = 0; i < d.length; i += 4) { const n = (R() - 0.5) * 70; d[i] += n; d[i + 1] += n; d[i + 2] += n; }
    ctx.putImageData(im, 0, 0);
  }
}
function evalFinger(ctx, cx, cy, len, wid, ang) {
  ctx.save(); ctx.translate(cx, cy); ctx.rotate(ang);
  const g = ctx.createLinearGradient(0, -wid / 2, 0, wid / 2);
  g.addColorStop(0, '#C98F6E'); g.addColorStop(0.5, '#EBB898'); g.addColorStop(1, '#B57B5C');
  ctx.fillStyle = g; ctx.beginPath(); ctx.ellipse(0, 0, len / 2, wid / 2, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = 'rgba(255,225,215,0.75)'; ctx.beginPath(); ctx.ellipse(len * 0.36, 0, len * 0.09, wid * 0.3, 0, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}
function evalLight(ctx, W, H, R) {
  const casts = [[1.14, 1.0, 0.82], [0.86, 0.97, 1.14], [0.94, 1.1, 0.9], [1.08, 0.94, 1.06]];
  const a = casts[Math.floor(R() * 4)], b = casts[Math.floor(R() * 4)];
  const ang = R() * Math.PI * 2, dx = Math.cos(ang), dy = Math.sin(ang), gain = 0.8 + R() * 0.35;
  const im = ctx.getImageData(0, 0, W, H), d = im.data;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const t = Math.max(0, Math.min(1, 0.5 + ((x / W - 0.5) * dx + (y / H - 0.5) * dy)));
    const v = gain * (1 - 0.25 * Math.hypot(x / W - 0.5, y / H - 0.5)), i = (y * W + x) * 4;
    d[i] *= v * (a[0] * (1 - t) + b[0] * t); d[i + 1] *= v * (a[1] * (1 - t) + b[1] * t); d[i + 2] *= v * (a[2] * (1 - t) + b[2] * t);
  }
  ctx.putImageData(im, 0, 0);
}
// mode 'A' = pieza chica y descentrada; 'B' = recorte parcial + dedo.
function makeTestPhoto(img, seed, mode) {
  const R = mulberry32((seed ^ 0x5bd1e995) >>> 0), rnd = (a, b) => a + (b - a) * R(), sgn = () => (R() < 0.5 ? -1 : 1);
  const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
  const portrait = R() < 0.5, W = portrait ? 600 : 800, H = portrait ? 800 : 600, S = Math.min(W, H);
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  evalTexture(ctx, W, H, R, Math.floor(R() * 4));
  let side, sx, sy, dst, cx, cy;
  if (mode === 'A') {
    side = Math.min(w, h) * rnd(0.85, 1.0); sx = (w - side) / 2; sy = (h - side) / 2;
    dst = S * rnd(0.40, 0.50);
    cx = W / 2 + sgn() * W * rnd(0.10, 0.2); cy = H / 2 + sgn() * H * rnd(0.10, 0.2);
  } else {
    side = Math.min(w, h) * rnd(0.55, 0.75);
    sx = (w - side) * (R() < 0.5 ? rnd(0.05, 0.3) : rnd(0.7, 0.95)); sy = (h - side) * (R() < 0.5 ? rnd(0.05, 0.3) : rnd(0.7, 0.95));
    dst = S * rnd(0.6, 0.8); cx = W / 2 + sgn() * W * rnd(0.02, 0.1); cy = H / 2 + sgn() * H * rnd(0.02, 0.1);
  }
  const T = 320, tile = document.createElement('canvas'); tile.width = T; tile.height = T;
  const tctx = tile.getContext('2d'); tctx.drawImage(img, sx, sy, side, side, 0, 0, T, T);
  if (R() < 0.5) { // borde redondeado (no el degradé radial del entrenamiento)
    tctx.globalCompositeOperation = 'destination-in'; tctx.beginPath();
    tctx.roundRect ? tctx.roundRect(0, 0, T, T, T * 0.18) : tctx.rect(0, 0, T, T); tctx.fill();
  }
  ctx.save(); ctx.translate(cx, cy); ctx.rotate(sgn() * rnd(10, 25) * Math.PI / 180);
  ctx.shadowColor = 'rgba(0,0,0,0.35)'; ctx.shadowBlur = 18; ctx.shadowOffsetX = 6; ctx.shadowOffsetY = 8;
  ctx.drawImage(tile, -dst / 2, -dst / 2, dst, dst); ctx.restore();
  if (mode === 'B') { // dedo sobre un borde de la pieza (~6–10 % del área de la pieza)
    const a = R() * Math.PI * 2, r = dst * 0.42;
    evalFinger(ctx, cx + Math.cos(a) * r, cy + Math.sin(a) * r, dst * rnd(0.45, 0.6), dst * rnd(0.17, 0.22), a + Math.PI / 2 * rnd(0.6, 1.4));
  }
  evalLight(ctx, W, H, R);
  return cv.toDataURL('image/jpeg', 0.6);
}
