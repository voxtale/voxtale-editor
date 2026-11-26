// Source imports stay extensionless so Next (Turbopack), bun and tsup all
// resolve the .ts files; Node ESM needs the .js suffix in the built dist.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";

for (const name of readdirSync("dist")) {
  if (!/\.(js|d\.ts)$/.test(name)) continue;
  const path = `dist/${name}`;
  writeFileSync(path, readFileSync(path, "utf8").replace(/(from\s+["'])(\.\/[a-z-]+)(["'])/g, "$1$2.js$3"));
}
