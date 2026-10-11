# Field Notes

Offline-first field journal for botanical observations in Tawang District, Arunachal Pradesh.
Photos, GPS, altitude and notes are stored **on the device** (IndexedDB) — no account or server needed.

## What it does

- **Camera capture that keeps working** — an in-app live camera (rear lens, torch, multi-shot) so the page is never sent to the background and the photo can't get lost. Falls back to the phone's camera app if camera permission is blocked.
- **Quick save as draft** — photograph an unknown plant, tap once, move to the next. GPS and time are attached automatically.
- **Drafts for unidentified plants** — anything saved without a scientific name (or with “Keep as draft” ticked) goes to *Records › Drafts* and shows a badge until you identify it.
- **Name search before entry** — type a few letters for suggestions (GBIF Backbone + iNaturalist common names). Picking a name fills family, genus and common name, flags synonyms with the accepted name, and shows a short Wikipedia description and GBIF occurrence counts (worldwide / India). Every value is labelled with its source; results are cached for offline use.
- **Per-species heatmaps (like iNaturalist)** — each species has its own page with a distribution heatmap, altitude range, first/last seen, a month-by-month seasonality chart (with share flowering), photos and records. The Map tab can show all records, drafts only, or any single species.
- **Location** — best-of-several GPS fix with accuracy; altitude from GPS, or a 90 m elevation model when GPS gives none (labelled as such); nearest place name from OpenStreetMap; GPS/date read from gallery photos’ EXIF.
- **Unsaved work is never lost** — the form autosaves; if the browser closes mid-entry you get a *Restore* banner.
- **Export** — full JSON backup (with photos), CSV with Darwin Core column names, and GeoJSON for QGIS. Import merges backups.
- **Works offline** — as an Android app or installed to the home screen; map areas you have viewed are cached for use without signal.

Missing values are shown as *not reported* rather than guessed.

## Android app

Download **[FieldNotes.apk](https://github.com/gekenriba/Field-Notes/releases/download/android-rebuild-local-first/FieldNotes.apk)** on your phone and open it. Android will ask you to allow installing from your browser/Files app the first time. Allow camera and location when the app asks.

- A new APK is built automatically by GitHub Actions on every push and attached to the release (`android-<branch>`). Newer builds install over older ones and keep your records.
- Each build is also installed on an Android emulator that takes a photo, gets GPS, looks up a name, saves a record and a draft, restarts the app, opens the maps and exports a file. The results (`emulator-results.md`) and screenshots are attached to the same release.
- Exports open the Android share sheet, so you can save the file to Files, Drive, WhatsApp or email.
- Data is stored inside the app. Uninstalling the app deletes it, so export a full backup now and then.
- Build locally (needs Android Studio / SDK and JDK 21): `npm install && npm run android`, then `cd android && ./gradlew assembleRelease`.

**Signing:** builds are signed with `android/app/fieldnotes-sideload.jks`, which is in this repo so every build can update the previous one. That is fine for installing on your own phones; before sharing the app widely or publishing to Play Store, create your own keystore and add it as repository secrets `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD` (the workflow uses them automatically; you'll need to uninstall the old build once).

## Run / deploy

It is a static site — no build step. Camera and GPS need HTTPS (or `localhost`).

- **GitHub Pages:** Settings → Pages → Deploy from branch → `main` / root.
- **Locally:** `python3 -m http.server 8000` then open `http://localhost:8000`.

On the phone, open the site in Chrome and choose *Add to Home screen*, then tap *Keep my data persistent* under ⋯ so the browser doesn't clear your records.

## Files

| Path | Purpose |
|---|---|
| `index.html` | App shell, camera and form markup |
| `css/app.css` | Styles |
| `js/app.js` | Views, camera flow, form, drafts, exports |
| `js/db.js` | IndexedDB storage and backup |
| `js/media.js` | Live camera, photo resizing, EXIF reader |
| `js/geo.js` | GPS, elevation model, place names |
| `js/taxon.js` | GBIF / iNaturalist / Wikipedia lookups |
| `js/maps.js` | Leaflet layers, heatmaps, markers |
| `js/native.js` | Android bridges (share sheet) |
| `sw.js` | Offline cache (browser only) |
| `android/` | Capacitor Android project |
| `.github/workflows/android.yml` | Builds the APK and runs the emulator test |
| `scripts/` | Web copy for the Android build; emulator test |
| `vendor/` | Leaflet 1.9.4, Leaflet.heat 0.2.0, Fraunces font (OFL) |

Data sources: GBIF Backbone Taxonomy, iNaturalist, Wikipedia, Open-Meteo (Copernicus DEM), OpenStreetMap/Nominatim, OpenTopoMap, Esri World Imagery.
