// Copies the web app into www/ for the Android build (Capacitor's webDir).
import { cpSync, rmSync, mkdirSync, existsSync } from 'node:fs';

const OUT = 'www';
const FILES = ['index.html', 'manifest.webmanifest', 'sw.js', 'css', 'js', 'vendor', 'icons', 'assets'];

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT);
for (const f of FILES) {
  if (!existsSync(f)) throw new Error(`Missing ${f}`);
  cpSync(f, `${OUT}/${f}`, { recursive: true });
}
console.log(`Web app copied to ${OUT}/`);
