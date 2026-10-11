# Field Notes

A field journal for botanists in the Eastern Himalaya. Developed by **Geken**.

Offline-first field journal for botanical observations in Tawang District, Arunachal Pradesh.
Photos, GPS, altitude and notes are stored **on the device** (IndexedDB) — no account or server needed.

## What it does

- **Live identification camera.** While you point the camera, on-device analysis marks flowers (with their colour) and foliage using small, unobtrusive callouts. When you hold steady, it asks [Pl@ntNet](https://my.plantnet.org) for likely species and shows the top three with family and confidence. Tap one to carry it into the entry. The callouts work offline; name suggestions need internet and a free Pl@ntNet API key (Settings).
- **Quick capture and drafts.** Save a plant as a draft in one tap and move on. GPS, time and any live suggestions are kept, and drafts wait under *Records › Drafts* until you identify them.
- **Suggestions on entries.** With photos attached, the entry shows likely species, plus the most likely genus and family when the species is uncertain, and whether GBIF has records of each suggestion in India. Picking a suggestion marks the ID as *probable*.
- **Growth stage and population.** Each record has a growth stage (BBCH-based: emerging, vegetative, buds, flowering with early/peak/late, fruiting, ripe/seeding, senescent, dormant) and the number of plants, counted or estimated.
- **Phenology.** *Flora › Phenology* draws a month-by-stage chart for every species from your records, filterable by family, with a table view. Each species and family page has its own.
- **Family icons.** Minimal icons generated from each family’s key traits (symmetry, petal number and shape, inflorescence type, typical colour) for ~60 families common in the Himalaya.
- **Maps.** A minimal map with contour lines and soft relief computed from open elevation data (tap anywhere for the elevation), satellite imagery with state and district boundaries, and a topographic style. Heatmaps are drawn only from identified plant observations; drafts and other organisms show as points. Map areas you view are cached for offline use.
- **Name lookups.** GBIF, iNaturalist and Wikipedia fill family, genus, accepted name and a short description, each labelled with its source.
- **Backup and moving phones.** One-tap backup to a .zip (records and full-size photos) via the share sheet, so you can save it to Google Drive. Restore merges it into any phone with Field Notes.
- **Export.** CSV with Darwin Core columns (including individualCount and growth stage) and GeoJSON for QGIS.

Missing values are shown as *not reported* rather than guessed.

## Android app

Download **[FieldNotes.apk](https://github.com/gekenriba/Field-Notes/releases/download/android-main/FieldNotes.apk)** on your phone and open it. Android will ask you to allow installing from your browser/Files app the first time. Allow camera and location when the app asks.

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
| `js/morph.js` | On-device flower and foliage detection for the live camera |
| `js/ident.js` | Pl@ntNet suggestions, daily quota guard, GBIF India check |
| `js/phenology.js` | Growth stages and phenology charts |
| `js/familyIcons.js` | Trait-based family icon generator |
| `js/contours.js` | Contour lines and relief from AWS Terrain Tiles |
| `js/backup.js` | Zip backup and restore |
| `js/ui.js` | Haptics and motion |
| `assets/hero/` | Home screen photos (Wikimedia Commons, credits in the app) |
| `assets/geo/` | India state and district boundaries (DataMeet) |
| `sw.js` | Offline cache (browser only) |
| `android/` | Capacitor Android project |
| `.github/workflows/android.yml` | Builds the APK and runs the emulator test |
| `scripts/` | Web copy for the Android build; emulator test |
| `vendor/` | Leaflet 1.9.4, Leaflet.heat 0.2.0, Fraunces font (OFL) |

Data sources: GBIF Backbone Taxonomy, iNaturalist, Wikipedia, Pl@ntNet, AWS Terrain Tiles, Open-Meteo (Copernicus DEM), OpenStreetMap/Nominatim, Esri, OpenTopoMap, Esri World Imagery, DataMeet boundaries (CC BY 4.0; districts as of Census 2011). Home screen photos: Wikimedia Commons contributors under CC BY / CC BY-SA, listed in Settings › Sources and credits.
