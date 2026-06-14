import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const [targetDirArg] = process.argv.slice(2);
if (!targetDirArg) {
  throw new Error("Usage: node scripts/fix-esm-imports.mjs <dist-dir>");
}

const targetDir = path.resolve(process.cwd(), targetDirArg);

for (const filePath of walk(targetDir)) {
  if (!filePath.endsWith(".js")) continue;
  const source = readFileSync(filePath, "utf8");
  const next = source.replace(
    /(from\s+["']|import\s*\(\s*["'])(\.[^"']+)(["']\s*\)?)/g,
    (match, prefix, specifier, suffix) => {
      const fixedSpecifier = resolveSpecifier(filePath, specifier);
      return fixedSpecifier === specifier ? match : `${prefix}${fixedSpecifier}${suffix}`;
    }
  );
  if (next !== source) {
    writeFileSync(filePath, next);
  }
}

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(entryPath);
    } else {
      yield entryPath;
    }
  }
}

function resolveSpecifier(importerPath, specifier) {
  if (path.extname(specifier)) return specifier;

  const importerDir = path.dirname(importerPath);
  if (existsSync(path.resolve(importerDir, `${specifier}.js`))) {
    return `${specifier}.js`;
  }
  if (existsSync(path.resolve(importerDir, specifier, "index.js"))) {
    return `${specifier}/index.js`;
  }
  return specifier;
}
