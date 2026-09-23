import { readFileSync } from "node:fs";
import { Script } from "node:vm";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(path.join(root, "index.html"), "utf8");
const inlineScripts = [...html.matchAll(/^<script>\r?\n([\s\S]*?)^<\/script>/gm)];
if (!inlineScripts.length) throw new Error("No se encontraron scripts inline para verificar.");
inlineScripts.forEach((match, index) => new Script(match[1], { filename: `index.html:inline-${index + 1}` }));
console.log(`${inlineScripts.length} scripts inline válidos`);
