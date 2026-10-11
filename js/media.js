// Photo handling: in-app live camera, resizing, thumbnails, and EXIF (GPS + date) reading.

const MAX_SIDE = 2048;     // stored photo, long edge in px
const THUMB_SIDE = 400;    // list/map thumbnails

async function loadBitmap(blob) {
  if ('createImageBitmap' in window) {
    try { return await createImageBitmap(blob, { imageOrientation: 'from-image' }); } catch { /* fall back */ }
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return img;
  } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
}

function drawScaled(src, maxSide, quality) {
  const w0 = src.width, h0 = src.height;
  const scale = Math.min(1, maxSide / Math.max(w0, h0));
  const w = Math.round(w0 * scale), h = Math.round(h0 * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, w, h);
  return new Promise((res, rej) =>
    canvas.toBlob((b) => (b ? res({ blob: b, w, h }) : rej(new Error('Could not encode image'))), 'image/jpeg', quality));
}

export async function processPhoto(fileOrBlob) {
  const exif = await readExif(fileOrBlob).catch(() => ({}));
  const bmp = await loadBitmap(fileOrBlob);
  const full = await drawScaled(bmp, MAX_SIDE, 0.86);
  const thumb = await drawScaled(bmp, THUMB_SIDE, 0.78);
  if (bmp.close) bmp.close();
  return { blob: full.blob, thumb: thumb.blob, w: full.w, h: full.h, exif };
}

// ---------------- Minimal EXIF reader (JPEG APP1) ----------------
export async function readExif(blob) {
  const buf = await blob.slice(0, 256 * 1024).arrayBuffer();
  const v = new DataView(buf);
  if (v.byteLength < 4 || v.getUint16(0) !== 0xffd8) return {};
  let off = 2;
  while (off + 4 < v.byteLength) {
    const marker = v.getUint16(off);
    const size = v.getUint16(off + 2);
    if (marker === 0xffe1 && v.getUint32(off + 4) === 0x45786966) return parseTiff(v, off + 10);
    if ((marker & 0xff00) !== 0xff00) break;
    off += 2 + size;
  }
  return {};
}

function parseTiff(v, start) {
  const le = v.getUint16(start) === 0x4949;
  const u16 = (o) => v.getUint16(o, le);
  const u32 = (o) => v.getUint32(o, le);
  const readIFD = (ifdOff) => {
    const tags = {};
    const abs = start + ifdOff;
    if (abs + 2 > v.byteLength) return tags;
    const n = u16(abs);
    for (let i = 0; i < n; i++) {
      const e = abs + 2 + i * 12;
      if (e + 12 > v.byteLength) break;
      tags[u16(e)] = { type: u16(e + 2), count: u32(e + 4), valOff: e + 8 };
    }
    return tags;
  };
  const rational = (t, idx = 0) => {
    const o = start + u32(t.valOff) + idx * 8;
    const d = u32(o + 4);
    return d ? u32(o) / d : 0;
  };
  const ascii = (t) => {
    const o = t.count > 4 ? start + u32(t.valOff) : t.valOff;
    let s = '';
    for (let i = 0; i < t.count - 1 && o + i < v.byteLength; i++) s += String.fromCharCode(v.getUint8(o + i));
    return s;
  };
  const out = {};
  const ifd0 = readIFD(u32(start + 4));
  const make = ifd0[0x010f] ? ascii(ifd0[0x010f]).trim() : '';
  const model = ifd0[0x0110] ? ascii(ifd0[0x0110]).trim() : '';
  if (model) out.camera = model.toLowerCase().startsWith(make.split(' ')[0].toLowerCase()) ? model : `${make} ${model}`.trim();
  if (ifd0[0x8769]) {
    const exifIFD = readIFD(u32(ifd0[0x8769].valOff));
    const dt = exifIFD[0x9003] || ifd0[0x0132];
    if (dt) {
      const m = ascii(dt).match(/(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2})/);
      if (m) { out.date = `${m[1]}-${m[2]}-${m[3]}`; out.time = `${m[4]}:${m[5]}`; }
    }
  }
  if (ifd0[0x8825]) {
    const g = readIFD(u32(ifd0[0x8825].valOff));
    const dms = (t) => rational(t, 0) + rational(t, 1) / 60 + rational(t, 2) / 3600;
    if (g[2] && g[4]) {
      let lat = dms(g[2]), lng = dms(g[4]);
      if (g[1] && ascii({ ...g[1], count: 2 }) === 'S') lat = -lat;
      if (g[3] && ascii({ ...g[3], count: 2 }) === 'W') lng = -lng;
      if (lat || lng) { out.lat = +lat.toFixed(6); out.lng = +lng.toFixed(6); }
    }
    if (g[6]) {
      let alt = rational(g[6]);
      if (g[5] && v.getUint8(g[5].valOff) === 1) alt = -alt;
      out.alt = Math.round(alt);
    }
  }
  return out;
}

// ---------------- In-app live camera ----------------
// Using getUserMedia keeps the page alive while shooting. Opening the phone's camera app
// through <input capture> lets Android discard the page in the background, which loses the
// photo — the most common reason a "take photo" button appears to do nothing.
export class LiveCamera {
  constructor(video) { this.video = video; this.stream = null; this.track = null; this.facing = 'environment'; }

  static supported() { return !!navigator.mediaDevices?.getUserMedia && window.isSecureContext; }

  async start() {
    this.stop();
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: this.facing }, width: { ideal: 4096 }, height: { ideal: 3072 } },
    });
    this.track = this.stream.getVideoTracks()[0];
    this.video.srcObject = this.stream;
    await this.video.play().catch(() => {});
    this.imageCapture = ('ImageCapture' in window) ? new window.ImageCapture(this.track) : null;
  }

  async flip() { this.facing = this.facing === 'environment' ? 'user' : 'environment'; await this.start(); }

  torchSupported() {
    try { return !!this.track?.getCapabilities?.().torch; } catch { return false; }
  }
  async setTorch(on) { try { await this.track.applyConstraints({ advanced: [{ torch: on }] }); } catch { /* ignore */ } }

  async snap() {
    // Prefer full-sensor stills where the browser supports it (Chrome on Android).
    if (this.imageCapture?.takePhoto) {
      try { return await this.imageCapture.takePhoto(); } catch { /* fall back to frame grab */ }
    }
    const v = this.video;
    const c = document.createElement('canvas');
    c.width = v.videoWidth; c.height = v.videoHeight;
    c.getContext('2d').drawImage(v, 0, 0);
    return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('Capture failed'))), 'image/jpeg', 0.92));
  }

  stop() {
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    this.stream = null; this.track = null; this.imageCapture = null;
    if (this.video) this.video.srcObject = null;
  }
}
