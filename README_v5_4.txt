# BixStudio v5.4 — Organizar todas las hojas

Cambios:
- Auto Organizar muestra dos opciones cuando existen varias Gang Sheets:
  - Hoja actual
  - Todas las hojas
- "Todas las hojas" usa un decoder multi-bin real.
- La métrica principal es reducir el número de Gang Sheets.
- Si 3 hojas pueden compactarse en 2 o 1, el proyecto se reconstruye automáticamente.
- Cada hoja resultante conserva máximo 62 × 310 cm.
- Trabajos muy grandes (250–999+) usan grid/presupuestos reducidos para evitar búsquedas interminables.

Archivos a reemplazar/subir:
- index.html
- bixnest/integration.js
- bixnest/strategy.js
- bixnest/worker.js
- bixnest/decoder.js
- bixnest/brkga.js

Sin cambios:
- bixnest/bitboards.js
- Cloud Run / Cloud Tasks / Supabase / Shopify
