// Backups as a .zip: data.json (records, cached lookups, settings) + photos as JPEG files.
// Built in streaming chunks so large collections don't exhaust memory. On Android the zip is
// written to the app cache in pieces and handed to the share sheet (Save to Drive, Files, …).
// Restoring merges into what is already on the device, so it also moves data between phones.

import { Zip, ZipDeflate, ZipPassThrough, Unzip, UnzipInflate, strToU8, strFromU8 } from '../vendor/fflate.js';
import { db, getMeta, setMeta, importBackup as importLegacyJson } from './db.js';

const cap = () => window.Capacitor;
const isNative = () => !!cap()?.isNativePlatform?.();

function blobToBase64(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(',')[1] || '');
    r.onerror = () => rej(r.error);
    r.readAsDataURL(blob);
  });
}

// Writes chunks either to memory (browser) or appends them to a native file.
class Sink {
  constructor(filename) { this.filename = filename; this.parts = []; this.pending = []; this.pendingSize = 0; this.started = false; this.chain = Promise.resolve(); this.size = 0; }
  push(chunk) {
    this.size += chunk.length;
    if (!isNative()) { this.parts.push(chunk); return; }
    this.pending.push(chunk); this.pendingSize += chunk.length;
    if (this.pendingSize > 3 * 1024 * 1024) this.flush();
  }
  flush() {
    if (!this.pending.length) return this.chain;
    const blob = new Blob(this.pending); this.pending = []; this.pendingSize = 0;
    const first = !this.started; this.started = true;
    this.chain = this.chain.then(async () => {
      const data = await blobToBase64(blob);
      await cap().nativePromise('Filesystem', first ? 'writeFile' : 'appendFile',
        { path: `exports/${this.filename}`, data, directory: 'CACHE', recursive: true });
    });
    return this.chain;
  }
  async finish() {
    if (!isNative()) return { blob: new Blob(this.parts, { type: 'application/zip' }) };
    await this.flush();
    const { uri } = await cap().nativePromise('Filesystem', 'getUri', { path: `exports/${this.filename}`, directory: 'CACHE' });
    return { uri };
  }
}

export async function buildBackup(onProgress) {
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const filename = `field-notes-backup-${stamp}.zip`;
  const sink = new Sink(filename);
  let failed = null;
  const zip = new Zip((err, chunk) => { if (err) failed = err; else sink.push(chunk); });

  const entries = await db.all('entries');
  const taxa = await db.all('taxa');
  const settings = await getMeta('settings', {});
  const photos = await db.all('photos');
  const meta = photos.map(({ blob, thumb, ...rest }) => ({ ...rest, hasThumb: !!thumb, type: blob?.type || 'image/jpeg' }));
  const data = { app: 'field-notes', format: 3, exportedAt: new Date().toISOString(), entries, taxa, photos: meta, settings: { recorder: settings.recorder || '' } };
  const dj = new ZipDeflate('data.json', { level: 6 });
  zip.add(dj); dj.push(strToU8(JSON.stringify(data)), true);

  let i = 0;
  for (const p of photos) {
    for (const [kind, blob] of [['photos', p.blob], ['thumbs', p.thumb]]) {
      if (!blob) continue;
      const f = new ZipPassThrough(`${kind}/${p.id}.jpg`);
      zip.add(f);
      f.push(new Uint8Array(await blob.arrayBuffer()), true);
    }
    i++;
    if (i % 10 === 0) { onProgress?.(i / photos.length); await sink.flush(); }
  }
  zip.end();
  if (failed) throw failed;
  const out = await sink.finish();
  await setMeta('lastBackup', { at: new Date().toISOString(), entries: entries.length, photos: photos.length, size: sink.size });
  return { filename, size: sink.size, entries: entries.length, photos: photos.length, ...out };
}

// Restore from a .zip (version 3) or a .json backup (version 2). Merges by record id; a record
// already on the device is replaced only when the backup copy is newer.
export async function restoreBackup(file, onProgress) {
  const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  const isZip = head[0] === 0x50 && head[1] === 0x4b;
  if (!isZip) return importLegacyJson(JSON.parse(await file.text()));

  const files = new Map();
  const unzip = new Unzip();
  unzip.register(UnzipInflate);
  unzip.onfile = (f) => {
    const chunks = [];
    f.ondata = (err, d, final) => {
      if (err) throw err;
      chunks.push(d);
      if (final) files.set(f.name, chunks);
    };
    f.start();
  };
  const CH = 1024 * 1024;
  for (let off = 0; off < file.size; off += CH) {
    const buf = new Uint8Array(await file.slice(off, off + CH).arrayBuffer());
    unzip.push(buf, off + CH >= file.size);
    onProgress?.(Math.min(1, (off + CH) / file.size) * 0.5);
  }
  const dataChunks = files.get('data.json');
  if (!dataChunks) throw new Error('This zip is not a Field Notes backup.');
  const data = JSON.parse(strFromU8(concat(dataChunks)));
  let added = 0, updated = 0, skipped = 0, n = 0;
  for (const p of data.photos || []) {
    n++;
    if (await db.get('photos', p.id)) continue;
    const full = files.get(`photos/${p.id}.jpg`); const th = files.get(`thumbs/${p.id}.jpg`);
    if (!full) continue;
    const { hasThumb, type, ...rest } = p;
    await db.put('photos', { ...rest, blob: new Blob(full, { type: type || 'image/jpeg' }), thumb: th ? new Blob(th, { type: 'image/jpeg' }) : null });
    if (n % 20 === 0) onProgress?.(0.5 + 0.4 * n / data.photos.length);
  }
  for (const t of data.taxa || []) if (!(await db.get('taxa', t.key))) await db.put('taxa', t);
  for (const e of data.entries || []) {
    const ex = await db.get('entries', e.id);
    if (!ex) { await db.put('entries', e); added++; }
    else if ((e.updatedAt || '') > (ex.updatedAt || '')) { await db.put('entries', e); updated++; }
    else skipped++;
  }
  onProgress?.(1);
  return { added, updated, skipped, photos: (data.photos || []).length };
}

function concat(chunks) {
  const len = chunks.reduce((a, c) => a + c.length, 0);
  const out = new Uint8Array(len); let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}
