// Elevation contour lines (and optional soft relief shading) drawn in the app from open
// terrain tiles (AWS Terrain Tiles, "terrarium" encoding: elevation = R*256 + G + B/256 − 32768).
// Data: SRTM / ETOPO1 / other public DEMs compiled by Mapzen, hosted on AWS Open Data.
/* global L */

const DEM_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
const DEM_MAX_Z = 13;   // enough detail for contours; deeper zooms reuse and upsample this level
const demCache = new Map();   // key -> Promise<{w,h,elev:Float32Array}>

async function cachedFetch(url) {
  try {
    const c = await caches.open('fn-dem');
    const hit = await c.match(url);
    if (hit) return hit.blob();
    const res = await fetch(url, { mode: 'cors', credentials: 'omit' });
    if (!res.ok) throw new Error(res.status);
    c.put(url, res.clone()).catch(() => {});
    return res.blob();
  } catch (e) {
    const res = await fetch(url, { mode: 'cors' });
    if (!res.ok) throw e;
    return res.blob();
  }
}

function loadDem(z, x, y) {
  const key = `${z}/${x}/${y}`;
  if (demCache.has(key)) return demCache.get(key);
  const p = (async () => {
    const blob = await cachedFetch(DEM_URL.replace('{z}', z).replace('{x}', x).replace('{y}', y));
    const bmp = await createImageBitmap(blob);
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0);
    const d = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
    const elev = new Float32Array(bmp.width * bmp.height);
    for (let i = 0, j = 0; i < elev.length; i++, j += 4) elev[i] = d[j] * 256 + d[j + 1] + d[j + 2] / 256 - 32768;
    return { w: bmp.width, h: bmp.height, elev };
  })();
  demCache.set(key, p);
  if (demCache.size > 120) demCache.delete(demCache.keys().next().value);
  p.catch(() => demCache.delete(key));
  return p;
}

// Elevation grid for an output tile at zoom z, sampled at `n`×`n` points (+1 border row/col).
async function gridFor(coords, n) {
  const dz = Math.max(0, coords.z - DEM_MAX_Z);
  const z = coords.z - dz;
  const scale = 2 ** dz;
  const x = Math.floor(coords.x / scale), y = Math.floor(coords.y / scale);
  const ox = (coords.x % scale) / scale, oy = (coords.y % scale) / scale;
  const dem = await loadDem(z, x, y);
  const g = new Float32Array((n + 1) * (n + 1));
  const span = (dem.w - 1) / scale;
  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) {
      const fx = Math.min(dem.w - 1.001, ox * (dem.w - 1) + (i / n) * span);
      const fy = Math.min(dem.h - 1.001, oy * (dem.h - 1) + (j / n) * span);
      const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
      const a = dem.elev[y0 * dem.w + x0], b = dem.elev[y0 * dem.w + x0 + 1];
      const c = dem.elev[(y0 + 1) * dem.w + x0], d = dem.elev[(y0 + 1) * dem.w + x0 + 1];
      g[j * (n + 1) + i] = (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
    }
  }
  return g;
}

// Contour interval / index interval by zoom, tuned for steep Himalayan terrain.
export function intervalFor(z) {
  if (z <= 9) return [500, 1000];
  if (z === 10) return [200, 1000];
  if (z === 11) return [100, 500];
  if (z === 12) return [50, 250];
  if (z === 13) return [40, 200];
  return [20, 100];
}

// Marching squares: returns line segments [x1,y1,x2,y2,...] in grid units for one level.
function isoSegments(g, n, level) {
  const out = [];
  const W = n + 1;
  const interp = (a, b, va, vb) => a + (b - a) * ((level - va) / (vb - va || 1e-9));
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const v0 = g[j * W + i], v1 = g[j * W + i + 1], v2 = g[(j + 1) * W + i + 1], v3 = g[(j + 1) * W + i];
      const idx = (v0 > level ? 8 : 0) | (v1 > level ? 4 : 0) | (v2 > level ? 2 : 0) | (v3 > level ? 1 : 0);
      if (idx === 0 || idx === 15) continue;
      const top = [interp(i, i + 1, v0, v1), j], right = [i + 1, interp(j, j + 1, v1, v2)];
      const bottom = [interp(i, i + 1, v3, v2), j + 1], left = [i, interp(j, j + 1, v0, v3)];
      const push = (p, q) => out.push(p[0], p[1], q[0], q[1]);
      switch (idx) {
        case 1: case 14: push(left, bottom); break;
        case 2: case 13: push(bottom, right); break;
        case 3: case 12: push(left, right); break;
        case 4: case 11: push(top, right); break;
        case 6: case 9: push(top, bottom); break;
        case 7: case 8: push(left, top); break;
        case 5: push(left, top); push(bottom, right); break;
        case 10: push(top, right); push(left, bottom); break;
      }
    }
  }
  return out;
}

export const ContourLayer = L.GridLayer.extend({
  options: { tileSize: 256, minZoom: 8, maxNativeZoom: 17, relief: true, light: false, updateWhenZooming: false, keepBuffer: 2,
    attribution: 'Contours from <a href="https://registry.opendata.aws/terrain-tiles/" target="_blank" rel="noopener">AWS Terrain Tiles</a> (SRTM and others)' },

  createTile(coords, done) {
    const size = this.getTileSize();
    const canvas = document.createElement('canvas');
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = size.x * dpr; canvas.height = size.y * dpr;
    const n = 128;
    gridFor(coords, n).then((g) => {
      const ctx = canvas.getContext('2d');
      ctx.scale(dpr, dpr);
      const k = size.x / n;
      const light = this.options.light;
      // Soft hillshade (light from the north-west), very low contrast.
      if (this.options.relief && !light) {
        const img = ctx.createImageData(n, n);
        const W = n + 1;
        const metersPerPx = 40075016 * Math.cos(this._lat(coords) * Math.PI / 180) / (256 * 2 ** coords.z) * (size.x / n);
        for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
          const z0 = g[j * W + i], zx = g[j * W + i + 1], zy = g[(j + 1) * W + i];
          const dx = (zx - z0) / metersPerPx, dy = (zy - z0) / metersPerPx;
          const shade = Math.max(-1, Math.min(1, -(dx + dy) * 0.9));   // >0 = slope facing away from the north-west light
          const o = (j * n + i) * 4;
          if (shade > 0) { img.data[o] = 28; img.data[o + 1] = 46; img.data[o + 2] = 58; img.data[o + 3] = Math.min(70, shade * 90); }
          else { img.data[o] = 255; img.data[o + 1] = 255; img.data[o + 2] = 255; img.data[o + 3] = Math.min(55, -shade * 80); }
        }
        const tmp = new OffscreenCanvas(n, n); tmp.getContext('2d').putImageData(img, 0, 0);
        ctx.imageSmoothingEnabled = true; ctx.drawImage(tmp, 0, 0, size.x, size.y);
      }
      let min = Infinity, max = -Infinity;
      for (const v of g) { if (v < min) min = v; if (v > max) max = v; }
      const [step, index] = intervalFor(coords.z);
      const labels = [];
      for (let level = Math.ceil(min / step) * step; level <= max; level += step) {
        if (level <= 0) continue;
        const seg = isoSegments(g, n, level);
        if (!seg.length) continue;
        const isIndex = level % index === 0;
        ctx.beginPath();
        for (let s = 0; s < seg.length; s += 4) { ctx.moveTo(seg[s] * k, seg[s + 1] * k); ctx.lineTo(seg[s + 2] * k, seg[s + 3] * k); }
        ctx.lineCap = 'round';
        ctx.strokeStyle = light ? (isIndex ? 'rgba(255,255,255,.85)' : 'rgba(255,255,255,.45)') : (isIndex ? 'rgba(104,78,48,.62)' : 'rgba(120,96,64,.30)');
        ctx.lineWidth = isIndex ? 1.15 : 0.6;
        ctx.stroke();
        if (isIndex && seg.length >= 40) {
          // Label near the middle of the tile on a fairly straight stretch.
          const m = Math.floor(seg.length / 8) * 4;
          const x = seg[m] * k, y = seg[m + 1] * k;
          if (x > 18 && x < size.x - 18 && y > 10 && y < size.y - 10 && labels.every(([lx, ly]) => Math.hypot(lx - x, ly - y) > 70)) {
            labels.push([x, y, Math.atan2(seg[m + 3] - seg[m + 1], seg[m + 2] - seg[m]), level]);
          }
        }
      }
      ctx.font = '600 9px "Instrument Sans", system-ui, sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      for (const [x, y, a, level] of labels) {
        ctx.save(); ctx.translate(x, y);
        let ang = a; if (ang > Math.PI / 2 || ang < -Math.PI / 2) ang += Math.PI;
        ctx.rotate(ang);
        ctx.lineWidth = 3; ctx.strokeStyle = light ? 'rgba(0,0,0,.55)' : 'rgba(247,248,246,.95)'; ctx.strokeText(`${level}`, 0, 0);
        ctx.fillStyle = light ? '#fff' : 'rgba(92,68,40,.95)'; ctx.fillText(`${level}`, 0, 0);
        ctx.restore();
      }
      done(null, canvas);
    }).catch((err) => done(err, canvas));
    return canvas;
  },

  _lat(c) {
    const n = Math.PI - 2 * Math.PI * (c.y + 0.5) / 2 ** c.z;
    return 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  },
});

// Elevation at a point (for tap-to-read on the map). Uses the same DEM tiles.
export async function elevationAt(lat, lng, z = 12) {
  const n = 2 ** z;
  const xf = (lng + 180) / 360 * n;
  const latR = lat * Math.PI / 180;
  const yf = (1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2 * n;
  const x = Math.floor(xf), y = Math.floor(yf);
  const dem = await loadDem(z, x, y);
  const px = Math.min(dem.w - 1, Math.floor((xf - x) * dem.w)), py = Math.min(dem.h - 1, Math.floor((yf - y) * dem.h));
  return Math.round(dem.elev[py * dem.w + px]);
}
