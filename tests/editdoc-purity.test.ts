// @voxtale/editdoc stays pure: shared by the editor and any future host.
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

function tsFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next" || name.startsWith(".")) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...tsFiles(path));
    else if (/\.(ts|tsx|mts|cts)$/.test(name)) out.push(path);
  }
  return out;
}

function importSpecifiers(path: string): string[] {
  const source = readFileSync(path, "utf8");
  const specs: string[] = [];
  const patterns = [
    /(?:^|\n)\s*(?:import|export)[^"'`]*?from\s*["']([^"']+)["']/g,
    /(?:^|\n)\s*import\s*["']([^"']+)["']/g,
    /import\s*\(\s*["']([^"']+)["']\s*\)/g,
    /require\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specs.push(match[1]!);
  }
  return specs;
}

describe("@voxtale/editdoc stays pure", () => {
  test("imports only zod and its own files; no Node, Bun or DOM I/O", () => {
    const violations: string[] = [];
    for (const file of tsFiles(join(ROOT, "packages/editdoc/src"))) {
      for (const spec of importSpecifiers(file))
        if (spec !== "zod" && !/^\.\/[a-z-]+$/.test(spec)) violations.push(`${file.slice(ROOT.length + 1)} imports "${spec}"`);
      if (/\b(fetch|process\.|Bun\.|document\.|window\.|localStorage)\b/.test(readFileSync(file, "utf8")))
        violations.push(`${file.slice(ROOT.length + 1)} touches I/O globals`);
    }
    expect(violations).toEqual([]);
  });
});
