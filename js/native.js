// Bridges to the Android app (Capacitor). In a normal browser these fall back to web behaviour.

const cap = () => window.Capacitor;

export const isNative = () => !!cap()?.isNativePlatform?.();

const call = (plugin, method, options) => cap().nativePromise(plugin, method, options);

// Writes a text file to the app's cache and opens the Android share sheet, so it can be
// saved to Files / Drive / WhatsApp etc. Returns true if handled natively.
export async function shareTextFile(filename, text, title = filename) {
  if (!isNative()) return false;
  const { uri } = await call('Filesystem', 'writeFile', {
    path: `exports/${filename}`, data: text, directory: 'CACHE', encoding: 'utf8', recursive: true,
  });
  try {
    await call('Share', 'share', { title, dialogTitle: `Save or send ${filename}`, files: [uri] });
  } catch (err) {
    // Closing the share sheet without choosing is not an error worth showing.
    if (!/cancel/i.test(String(err?.message || err))) throw err;
  }
  return true;
}

const blobToBase64 = (blob) => new Promise((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(String(r.result).split(',')[1] || '');
  r.onerror = () => rej(r.error);
  r.readAsDataURL(blob);
});

/**
 * HTTP request that, in the Android app, goes through Android's own networking instead of the
 * WebView. That avoids browser restrictions (CORS, "authorized domain" checks on API keys) and
 * lets us follow redirects such as maps.app.goo.gl short links. In a browser it uses fetch.
 *
 * body: object (sent as JSON) | { form: [{ name, value } | { name, blob, filename }] } (multipart)
 * returns { status, ok, data, url, headers }
 */
export async function http(url, { method = 'GET', headers = {}, body, responseType = 'json', timeout = 60000 } = {}) {
  if (isNative()) {
    const opts = { url, method, headers: { ...headers }, responseType, connectTimeout: 20000, readTimeout: timeout };
    if (body?.form) {
      const data = [];
      for (const f of body.form) {
        if (f.blob) data.push({ key: f.name, value: await blobToBase64(f.blob), type: 'base64File', contentType: f.blob.type || 'image/jpeg', fileName: f.filename || 'photo.jpg' });
        else data.push({ key: f.name, value: String(f.value), type: 'string' });
      }
      opts.data = data; opts.dataType = 'formData';
      opts.headers['Content-Type'] = 'multipart/form-data';
    } else if (body !== undefined) {
      opts.data = body; opts.headers['Content-Type'] = 'application/json';
    }
    const r = await call('CapacitorHttp', 'request', opts);
    let data = r.data;
    if (typeof data === 'string' && responseType === 'json') { try { data = JSON.parse(data); } catch { /* keep text */ } }
    return { status: r.status, ok: r.status >= 200 && r.status < 300, data, url: r.url || url, headers: r.headers || {} };
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const init = { method, headers: { ...headers }, signal: ctrl.signal };
    if (body?.form) {
      const fd = new FormData();
      for (const f of body.form) f.blob ? fd.append(f.name, f.blob, f.filename || 'photo.jpg') : fd.append(f.name, f.value);
      init.body = fd;
    } else if (body !== undefined) {
      init.body = JSON.stringify(body); init.headers['Content-Type'] = 'application/json';
    }
    const res = await fetch(url, init);
    const text = await res.text();
    let data = text;
    if (responseType === 'json') { try { data = JSON.parse(text); } catch { /* keep text */ } }
    return { status: res.status, ok: res.ok, data, url: res.url || url, headers: Object.fromEntries(res.headers.entries()) };
  } finally { clearTimeout(t); }
}
