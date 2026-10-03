# Paper Archive — source

The site (`../index.html`) is built from these files.

- `app.tsx` — screens, archive UI, categories, exports, app state
- `store.tsx` — on-device storage (IndexedDB): saved archives and pages
- `real.tsx` — real camera: paper detection, focus check, capture & flattening, text reading (Tesseract.js), sorting rules, duplicate detection
- `main.tsx` — mounts the app
- `style.css` — styles

Build: `npm i esbuild@0.23.1` then `bash build.sh` → `paper-archive.html`, which is wrapped into `index.html` for GitHub Pages.
