#!/usr/bin/env node
// Checks that all locale translation files have the same keys as en.json.
// Exits with code 1 if any keys are missing or extra.

import { readFileSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const localesDir = join(__dirname, "../src/i18n/locales");

function flattenKeys(obj, prefix = "") {
  return Object.entries(obj).flatMap(([key, value]) => {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === "object") {
      return flattenKeys(value, fullKey);
    }
    return [fullKey];
  });
}

const files = readdirSync(localesDir).filter((f) => f.endsWith(".json"));
const reference = "en.json";

if (!files.includes(reference)) {
  console.error(`Reference file ${reference} not found in ${localesDir}`);
  process.exit(1);
}

const referenceKeys = new Set(
  flattenKeys(JSON.parse(readFileSync(join(localesDir, reference), "utf8")))
);

let hasErrors = false;

for (const file of files) {
  if (file === reference) continue;

  const locale = file.replace(".json", "");
  const keys = new Set(
    flattenKeys(JSON.parse(readFileSync(join(localesDir, file), "utf8")))
  );

  const missing = [...referenceKeys].filter((k) => !keys.has(k));
  const extra = [...keys].filter((k) => !referenceKeys.has(k));

  if (missing.length > 0) {
    console.error(`[${locale}] Missing keys (${missing.length}):`);
    for (const k of missing) console.error(`  - ${k}`);
    hasErrors = true;
  }

  if (extra.length > 0) {
    console.error(`[${locale}] Extra keys not in ${reference} (${extra.length}):`);
    for (const k of extra) console.error(`  + ${k}`);
    hasErrors = true;
  }

  if (missing.length === 0 && extra.length === 0) {
    console.log(`[${locale}] OK`);
  }
}

if (hasErrors) {
  process.exit(1);
}
