// On-device morphology cues for the live camera. Runs on small video frames (~112 px wide)
// a few times per second and finds:
//   • flower-like regions — saturated non-green colour, or white regions set among foliage
//   • foliage — the main green mass
// It also names the flower colour and reports whether the camera is held still.
// These are colour-based estimates, not identifications; boxes only appear after they persist
// for several frames, and nothing is shown when nothing is found.

const W = 112;

function rgb2hsv(r, g, b) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6; else if (max === g) h = (b - r) / d + 2; else h = (r - g) / d + 4;
    h *= 60; if (h < 0) h += 360;
  }
  return [h, max ? d / max : 0, max / 255];
}

export function colourName(h, s, v) {
  if (s < 0.2 && v > 0.7) return 'white';
  if ((h >= 300 || h < 25) && s < 0.62 && v > 0.62) return 'pink';
  if (s < 0.45 && (h >= 300 || h < 15)) return 'pink';
  if (h >= 190 && h < 285 && s < 0.4 && v > 0.65) return 'pale blue-violet';
  if (h < 15 || h >= 345) return 'red';
  if (h < 40) return 'orange';
  if (h < 68) return 'yellow';
  if (h < 190) return 'green';
  if (h < 215) return 'blue';
  if (h < 255) return 'blue-violet';
  if (h < 285) return 'purple';
  if (h < 320) return 'magenta';
  return 'pink';
}

function components(mask, w, h, minArea) {
  const lab = new Int32Array(w * h).fill(-1);
  const comps = [];
  const stack = [];
  for (let i = 0; i < w * h; i++) {
    if (!mask[i] || lab[i] !== -1) continue;
    const id = comps.length;
    const c = { id, n: 0, x0: w, y0: h, x1: 0, y1: 0, sx: 0, sy: 0, pix: [] };
    lab[i] = id; stack.push(i);
    while (stack.length) {
      const p = stack.pop(); const x = p % w, y = (p / w) | 0;
      c.n++; c.sx += x; c.sy += y; c.pix.push(p);
      if (x < c.x0) c.x0 = x; if (x > c.x1) c.x1 = x; if (y < c.y0) c.y0 = y; if (y > c.y1) c.y1 = y;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const q = ny * w + nx;
        if (mask[q] && lab[q] === -1) { lab[q] = id; stack.push(q); }
      }
    }
    if (c.n >= minArea) comps.push(c);
  }
  return comps;
}

function dilate(mask, w, h) {
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let on = 0;
    for (let dy = -1; dy <= 1 && !on; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && ny >= 0 && nx < w && ny < h && mask[ny * w + nx]) { on = 1; break; }
    }
    out[y * w + x] = on;
  }
  return out;
}

// One analysis pass over an ImageData-like {data,width,height}.
export function analyseFrame(img) {
  const { data, width: w, height: h } = img;
  const N = w * h;
  const H = new Float32Array(N), S = new Float32Array(N), V = new Float32Array(N);
  const flower = new Uint8Array(N), white = new Uint8Array(N), green = new Uint8Array(N);
  let greenCount = 0;
  for (let i = 0, j = 0; i < N; i++, j += 4) {
    const [hh, ss, vv] = rgb2hsv(data[j], data[j + 1], data[j + 2]);
    H[i] = hh; S[i] = ss; V[i] = vv;
    if (hh >= 68 && hh < 175 && ss > 0.2 && vv > 0.15) { green[i] = 1; greenCount++; }
    else if (hh >= 190 && hh < 300 && ((ss > 0.3 && vv > 0.45) || (ss > 0.14 && vv > 0.68))) flower[i] = 1;            // blue, violet, purple (incl. pale poppies)
    else if ((hh >= 300 || hh < 10) && ((ss > 0.3 && vv > 0.35) || (ss > 0.14 && vv > 0.8))) flower[i] = 1;   // magenta, pink, red, pale pink
    else if (hh >= 10 && hh < 40 && ss > 0.6 && vv > 0.45) flower[i] = 1;              // orange (skin and soil are less saturated)
    else if (hh >= 40 && hh < 68 && ss > 0.5 && vv > 0.55) flower[i] = 1;              // yellow
    else if (ss < 0.16 && vv > 0.8) white[i] = 1;
  }
  const minArea = Math.max(6, N * 0.003);
  const out = { flowers: [], foliage: null, greenShare: greenCount / N };

  const consider = (c, isWhite) => {
    const area = c.n / N;
    if (area > 0.85) return;                                       // whole frame one colour: no shape to point at
    let hs = 0, hc = 0, ss = 0, vs = 0;
    for (const p of c.pix) { const a = H[p] * Math.PI / 180; hs += Math.sin(a); hc += Math.cos(a); ss += S[p]; vs += V[p]; }
    let hue = Math.atan2(hs, hc) * 180 / Math.PI; if (hue < 0) hue += 360;
    const sat = ss / c.n, val = vs / c.n;
    const touchesTop = c.y0 === 0;
    if (touchesTop && hue > 185 && hue < 235 && area > 0.06) return;   // likely sky
    // Require some foliage around white regions (snow, cloud and paper are white too).
    const ring = (x0, y0, x1, y1) => {
      let g = 0, t = 0; const px = Math.max(2, (x1 - x0) * 0.4) | 0, py = Math.max(2, (y1 - y0) * 0.4) | 0;
      for (let y = Math.max(0, y0 - py); y <= Math.min(h - 1, y1 + py); y++) for (let x = Math.max(0, x0 - px); x <= Math.min(w - 1, x1 + px); x++) {
        if (x >= x0 && x <= x1 && y >= y0 && y <= y1) continue; t++; g += green[y * w + x];
      }
      return t ? g / t : 0;
    };
    const greenAround = ring(c.x0, c.y0, c.x1, c.y1);
    if (isWhite && (greenAround < 0.3 || area > 0.25)) return;
    if (!isWhite && hue > 185 && hue < 240 && greenAround < 0.08 && area > 0.2) return;   // large plain blue area: sky, tarp, jacket
    const colour = isWhite ? 'white' : colourName(hue, sat, val);
    if (colour === 'green') return;
    out.flowers.push({ x0: c.x0 / w, y0: c.y0 / h, x1: (c.x1 + 1) / w, y1: (c.y1 + 1) / h, area, colour, n: 1 });
  };
  for (const c of components(dilate(flower, w, h), w, h, minArea)) consider(c, false);
  for (const c of components(dilate(white, w, h), w, h, minArea)) consider(c, true);

  // Many small flowers close together read as one inflorescence.
  out.flowers.sort((a, b) => b.area - a.area);
  const merged = [];
  for (const f of out.flowers) {
    const m = merged.find((g) => g.colour === f.colour && f.x0 < g.x1 + 0.06 && f.x1 > g.x0 - 0.06 && f.y0 < g.y1 + 0.06 && f.y1 > g.y0 - 0.06);
    if (m) { m.x0 = Math.min(m.x0, f.x0); m.y0 = Math.min(m.y0, f.y0); m.x1 = Math.max(m.x1, f.x1); m.y1 = Math.max(m.y1, f.y1); m.area += f.area; m.n++; }
    else merged.push({ ...f });
  }
  out.flowers = merged.filter((f) => f.area >= 0.004).slice(0, 3);

  if (out.greenShare > 0.12) {
    const gc = components(green, w, h, N * 0.04).sort((a, b) => b.n - a.n)[0];
    if (gc) out.foliage = { x0: gc.x0 / w, y0: gc.y0 / h, x1: (gc.x1 + 1) / w, y1: (gc.y1 + 1) / h, cx: gc.sx / gc.n / w, cy: gc.sy / gc.n / h, area: gc.n / N };
  }
  // 8×8 brightness signature for steadiness.
  const sig = new Float32Array(64);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) sig[((y * 8 / h) | 0) * 8 + ((x * 8 / w) | 0)] += V[y * w + x];
  const cell = (w * h) / 64; for (let i = 0; i < 64; i++) sig[i] = sig[i] / cell * 255;
  out.sig = sig;
  return out;
}

const iou = (a, b) => {
  const ix = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)), iy = Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
  const inter = ix * iy, u = (a.x1 - a.x0) * (a.y1 - a.y0) + (b.x1 - b.x0) * (b.y1 - b.y0) - inter;
  return u > 0 ? inter / u : 0;
};

// Runs the analysis on a <video> and keeps smoothed, persistent tracks for display.
export class MorphScanner {
  constructor(video, { onChange } = {}) {
    this.video = video; this.onChange = onChange;
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.tracks = []; this.nextId = 1; this.prevSig = null; this.stillSince = 0; this.running = false;
  }
  start() { if (this.running) return; this.running = true; this.tick(); }
  stop() { this.running = false; clearTimeout(this.timer); this.tracks = []; this.onChange?.(this.snapshot()); }

  tick() {
    if (!this.running) return;
    const t0 = performance.now();
    const v = this.video;
    if (v.videoWidth) {
      const h = Math.round(W * v.videoHeight / v.videoWidth);
      if (this.canvas.width !== W || this.canvas.height !== h) { this.canvas.width = W; this.canvas.height = h; }
      this.ctx.drawImage(v, 0, 0, W, h);
      const res = analyseFrame(this.ctx.getImageData(0, 0, W, h));
      this.update(res);
    }
    const spent = performance.now() - t0;
    this.timer = setTimeout(() => this.tick(), Math.max(120, 220 - spent));
  }

  update(res) {
    // Steadiness from the brightness signature.
    if (this.prevSig) {
      let d = 0; for (let i = 0; i < 64; i++) d += Math.abs(res.sig[i] - this.prevSig[i]);
      d /= 64;
      if (d < 7) { if (!this.stillSince) this.stillSince = performance.now(); } else this.stillSince = 0;
      this.motion = d;
    }
    this.prevSig = res.sig;
    const dets = res.flowers.map((f) => ({ kind: 'flower', ...f }));
    if (res.foliage) dets.push({ kind: 'foliage', ...res.foliage });
    for (const t of this.tracks) t.matched = false;
    for (const d of dets) {
      let best = null, bi = 0.15;
      for (const t of this.tracks) if (!t.matched && t.kind === d.kind && iou(t.target, d) > bi) { best = t; bi = iou(t.target, d); }
      if (best) { best.target = d; best.hits++; best.misses = 0; best.matched = true; best.colour = d.colour || best.colour; best.n = d.n; }
      else this.tracks.push({ id: this.nextId++, kind: d.kind, target: d, box: { ...d }, hits: 1, misses: 0, matched: true, colour: d.colour, n: d.n });
    }
    for (const t of this.tracks) if (!t.matched) t.misses++;
    this.tracks = this.tracks.filter((t) => t.misses < 5);
    this.onChange?.(this.snapshot());
  }

  snapshot() {
    const visible = this.tracks.filter((t) => t.hits >= 3);
    return {
      tracks: visible,
      flowers: visible.filter((t) => t.kind === 'flower'),
      foliage: visible.find((t) => t.kind === 'foliage') || null,
      still: !!this.stillSince && performance.now() - this.stillSince > 900,
      motion: this.motion ?? 99,
    };
  }
}

// Map normalised frame coordinates to on-screen coordinates for a video shown with object-fit: cover.
export function coverTransform(video) {
  const vw = video.clientWidth, vh = video.clientHeight, iw = video.videoWidth || 1, ih = video.videoHeight || 1;
  const s = Math.max(vw / iw, vh / ih);
  const dw = iw * s, dh = ih * s;
  return (x, y) => [x * dw - (dw - vw) / 2, y * dh - (dh - vh) / 2];
}
