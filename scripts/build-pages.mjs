import { cp, mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const outputDir = path.resolve(projectRoot, "dist");

if (path.dirname(outputDir) !== projectRoot || path.basename(outputDir) !== "dist") {
  throw new Error("Directorio de salida inseguro.");
}

const publishFiles = [
  "index.html",
  "processor.worker.js",
  "bixnest/bitboards.js",
  "bixnest/brkga.js",
  "bixnest/decoder.js",
  "bixnest/integration.js",
  "bixnest/strategy.js",
  "bixnest/worker.js"
];

await rm(outputDir, { recursive: true, force: true });
await mkdir(outputDir, { recursive: true });

let totalBytes = 0;
for (const relativeFile of publishFiles) {
  const source = path.resolve(projectRoot, relativeFile);
  const destination = path.resolve(outputDir, relativeFile);
  if (!source.startsWith(`${projectRoot}${path.sep}`)) {
    throw new Error(`Ruta fuera del proyecto: ${relativeFile}`);
  }
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(source, destination);
  totalBytes += (await stat(source)).size;
}

console.log(`BixStudio Pages: ${publishFiles.length} archivos, ${(totalBytes / 1024).toFixed(1)} KiB`);
