import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const output = resolve(root, "schema", "stream-json.v1.json");
const modulePath = resolve(root, "dist", "src", "cli", "stream-json-schema.js");
const { generateStreamJsonSchema } = await import(pathToFileURL(modulePath));

await mkdir(dirname(output), { recursive: true });
await writeFile(
  output,
  `${JSON.stringify(generateStreamJsonSchema(), null, 2)}\n`,
  "utf8",
);
process.stdout.write(`generated ${output}\n`);
