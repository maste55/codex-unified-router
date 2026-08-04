import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const codexHome = path.dirname(root);
const cachePath = path.join(codexHome, "models_cache.json");
const setupPath = path.join(process.env.TEMP, "deepseek-codex-review", "setup.ps1");
const outputPath = path.join(codexHome, "unified-models.json");

const cache = JSON.parse(fs.readFileSync(cachePath, "utf8"));
const setup = fs.readFileSync(setupPath, "utf8");
const match = setup.match(/\$ModelsJson\s*=\s*@'\r?\n([\s\S]*?)\r?\n'@/);
if (!match) throw new Error("DeepSeek official models.json block was not found");

const deepSeekCatalog = JSON.parse(match[1]);
const flash = deepSeekCatalog.models.find((model) => model.slug === "deepseek-v4-flash");
if (!flash) throw new Error("deepseek-v4-flash metadata was not found");

const models = cache.models.filter((model) => model.visibility === "list");
const withoutDuplicate = models.filter((model) => model.slug !== flash.slug);
withoutDuplicate.push(flash);

fs.writeFileSync(outputPath, `${JSON.stringify({ models: withoutDuplicate }, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ outputPath, modelCount: withoutDuplicate.length, added: flash.slug }));
