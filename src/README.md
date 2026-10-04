# Paper Archive — source

The site (`../index.html`) is built from these files.

- `app.tsx` — screens, archive UI, categories, exports, app state
- `i18n.tsx` — languages (English, Hebrew, Arabic): `t()` lookup, plural forms, right-to-left, language picker and switcher; choice kept in localStorage `pa.lang`
- `dict.tsx` — Hebrew and Arabic texts (one row per English text) and plural forms
- `wrap-i18n.js` — one-off helper that marked on-screen English text with `t()` (needs `npm i @babel/parser`)
- `store.tsx` — on-device storage (IndexedDB): saved archives and pages
- `real.tsx` — real camera: paper detection, focus check, capture & flattening, text reading (Tesseract.js), sorting rules, duplicate detection
- `main.tsx` — mounts the app
- `style.css` — styles

New on-screen text: write it in English inside `t('…')` and add a row to `dict.tsx`.

Build: `npm i esbuild@0.23.1` then `bash build.sh` → `paper-archive.html`, which is wrapped into `index.html` for GitHub Pages.
