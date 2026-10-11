// Local-first storage for Field Notes. Everything lives in IndexedDB on the device.
//   entries : field records (metadata only)
//   photos  : full-size + thumbnail JPEG blobs, referenced from entries by id
//   taxa    : cached web lookups (GBIF / Wikipedia / iNaturalist) so they work offline later
//   meta    : small key/value items (settings, unsaved form)

const DB_NAME = 'field-notes';
const DB_VERSION = 1;
let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('entries')) {
        const s = db.createObjectStore('entries', { keyPath: 'id' });
        s.createIndex('status', 'status');
        s.createIndex('updatedAt', 'updatedAt');
      }
      if (!db.objectStoreNames.contains('photos')) db.createObjectStore('photos', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('taxa')) db.createObjectStore('taxa', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('Database blocked — close other Field Notes tabs.'));
  });
  return dbPromise;
}

function wrap(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    let result;
    Promise.resolve(fn(t.objectStore(store))).then((r) => { result = r; }, reject);
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Transaction aborted'));
  });
}

export const uid = () =>
  (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

export const db = {
  async all(store) { return tx(store, 'readonly', (s) => wrap(s.getAll())); },
  async get(store, key) { return tx(store, 'readonly', (s) => wrap(s.get(key))); },
  async put(store, value) { return tx(store, 'readwrite', (s) => wrap(s.put(value))); },
  async del(store, key) { return tx(store, 'readwrite', (s) => wrap(s.delete(key))); },
  async clear(store) { return tx(store, 'readwrite', (s) => wrap(s.clear())); },
};

export async function getMeta(key, fallback = null) {
  const row = await db.get('meta', key);
  return row ? row.value : fallback;
}
export async function setMeta(key, value) { return db.put('meta', { key, value }); }
export async function delMeta(key) { return db.del('meta', key); }

export async function deleteEntry(entry) {
  for (const pid of entry.photoIds || []) await db.del('photos', pid);
  await db.del('entries', entry.id);
}

// Ask the browser not to evict our data when storage is low.
export async function requestPersistence() {
  try {
    if (navigator.storage?.persisted && !(await navigator.storage.persisted())) {
      return await navigator.storage.persist();
    }
    return true;
  } catch { return false; }
}

export async function storageEstimate() {
  try {
    const est = await navigator.storage.estimate();
    const persisted = navigator.storage.persisted ? await navigator.storage.persisted() : false;
    return { usage: est.usage || 0, quota: est.quota || 0, persisted };
  } catch { return null; }
}

// ---------- Backup ----------
const blobToDataURL = (blob) => new Promise((res, rej) => {
  const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsDataURL(blob);
});
const dataURLToBlob = async (url) => (await fetch(url)).blob();

export async function exportBackup() {
  const entries = await db.all('entries');
  const photos = [];
  for (const p of await db.all('photos')) {
    photos.push({ ...p, blob: await blobToDataURL(p.blob), thumb: p.thumb ? await blobToDataURL(p.thumb) : null });
  }
  const taxa = await db.all('taxa');
  return { app: 'field-notes', version: 2, exportedAt: new Date().toISOString(), entries, photos, taxa };
}

export async function importBackup(data) {
  if (!data || !Array.isArray(data.entries)) throw new Error('Not a Field Notes backup file.');
  let added = 0, updated = 0, skipped = 0;
  for (const p of data.photos || []) {
    if (await db.get('photos', p.id)) continue;
    await db.put('photos', { ...p, blob: await dataURLToBlob(p.blob), thumb: p.thumb ? await dataURLToBlob(p.thumb) : null });
  }
  for (const t of data.taxa || []) if (!(await db.get('taxa', t.key))) await db.put('taxa', t);
  for (const e of data.entries) {
    const existing = await db.get('entries', e.id);
    if (!existing) { await db.put('entries', e); added++; }
    else if ((e.updatedAt || '') > (existing.updatedAt || '')) { await db.put('entries', e); updated++; }
    else skipped++;
  }
  return { added, updated, skipped };
}
