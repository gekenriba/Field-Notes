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
