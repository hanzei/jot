#!/usr/bin/env node
// Checks that all locale translation files have the same keys as en.json.
// Exits with code 1 if any keys are missing or extra.

import { existsSync, readFileSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const localeDirs = [
  join(__dirname, "../src/i18n/locales"),
  join(__dirname, "../../mobile/src/i18n/locales"),
];

function flattenKeys(obj, prefix = "") {
  return Object.entries(obj).flatMap(([key, value]) => {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === "object") {
      const isEmpty = Array.isArray(value)
        ? value.length === 0
        : Object.keys(value).length === 0;
      if (isEmpty) return [fullKey];
      return flattenKeys(value, fullKey);
    }
    return [fullKey];
  });
}

function parseJsonFile(filepath) {
  let result;
  try {
    result = JSON.parse(readFileSync(filepath, "utf8"));
  } catch (err) {
    console.error(`Failed to parse ${filepath}: ${err.message}`);
    process.exit(1);
  }
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    console.error(`Expected a plain object in ${filepath} (used by flattenKeys), got ${Array.isArray(result) ? "array" : typeof result}`);
    process.exit(1);
  }
  return result;
}

let hasErrors = false;

for (const localesDir of localeDirs) {
  if (!existsSync(localesDir)) continue;

  const files = readdirSync(localesDir).filter((f) => f.endsWith(".json"));
  const reference = "en.json";

  if (!files.includes(reference)) {
    console.error(`Reference file ${reference} not found in ${localesDir}`);
    hasErrors = true;
    continue;
  }

  const referenceKeys = new Set(
    flattenKeys(parseJsonFile(join(localesDir, reference)))
  );

  for (const file of files) {
    if (file === reference) continue;

    const locale = file.replace(".json", "");
    const keys = new Set(
      flattenKeys(parseJsonFile(join(localesDir, file)))
    );

    const missing = [...referenceKeys].filter((k) => !keys.has(k));
    const extra = [...keys].filter((k) => !referenceKeys.has(k));

    if (missing.length > 0) {
      console.error(`[${localesDir}:${locale}] Missing keys (${missing.length}):`);
      for (const k of missing) console.error(`  - ${k}`);
      hasErrors = true;
    }

    if (extra.length > 0) {
      console.error(`[${localesDir}:${locale}] Extra keys not in ${reference} (${extra.length}):`);
      for (const k of extra) console.error(`  + ${k}`);
      hasErrors = true;
    }

    if (missing.length === 0 && extra.length === 0) {
      console.log(`[${localesDir}:${locale}] OK`);
    }
  }
}

if (hasErrors) {
  process.exit(1);
}
