#!/usr/bin/env node
// Checks that all locale translation files have the same keys as en.json,
// and that every key in en.json is actually referenced from source.
// Exits with code 1 if any keys are missing, extra, or unused.

import { existsSync, readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const localeDirs = [
  join(__dirname, '../src/i18n/locales'),
  join(__dirname, '../../mobile/src/i18n/locales'),
];

// Key prefixes assembled at runtime (template literals, e.g. `t(`settings.language_${lang}`)`)
// rather than referenced as a literal dotted path. A key under one of these prefixes cannot
// be found by the source scan below, so it is exempted rather than flagged as unused.
const DYNAMIC_KEY_PREFIXES = ['settings.language_', 'dashboard.sortOption.'];

// i18next plural suffixes. A key like `note.itemsPasted_one` is never referenced with its
// suffix in source — callers pass the base key (`t('note.itemsPasted', { count })`) and
// i18next appends the suffix for the resolved plural form.
const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;

// Source root each locale directory's keys are referenced from, for the unused-key scan.
const sourceRootFor = (localesDir) => join(localesDir, '../../..');

function collectSourceFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectSourceFiles(full, out);
    } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
      out.push(full);
    }
  }
  return out;
}

function findUnusedKeys(keys, sourceRoot) {
  const corpus = collectSourceFiles(sourceRoot)
    .map((f) => readFileSync(f, 'utf8'))
    .join('\n');

  return keys.filter((key) => {
    if (DYNAMIC_KEY_PREFIXES.some((prefix) => key.startsWith(prefix))) return false;
    const baseKey = key.replace(PLURAL_SUFFIX, '');
    return !corpus.includes(key) && !corpus.includes(baseKey);
  });
}

function flattenKeys(obj, prefix = '') {
  return Object.entries(obj).flatMap(([key, value]) => {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === 'object') {
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
    result = JSON.parse(readFileSync(filepath, 'utf8'));
  } catch (err) {
    console.error(`Failed to parse ${filepath}: ${err.message}`);
    process.exit(1);
  }
  if (typeof result !== 'object' || result === null || Array.isArray(result)) {
    console.error(`Expected a plain object in ${filepath} (used by flattenKeys), got ${Array.isArray(result) ? 'array' : typeof result}`);
    process.exit(1);
  }
  return result;
}

let hasErrors = false;

for (const localesDir of localeDirs) {
  if (!existsSync(localesDir)) continue;

  const files = readdirSync(localesDir).filter((f) => f.endsWith('.json'));
  const reference = 'en.json';

  if (!files.includes(reference)) {
    console.error(`Reference file ${reference} not found in ${localesDir}`);
    hasErrors = true;
    continue;
  }

  const referenceKeys = new Set(
    flattenKeys(parseJsonFile(join(localesDir, reference)))
  );

  const unused = findUnusedKeys([...referenceKeys], sourceRootFor(localesDir));
  if (unused.length > 0) {
    console.error(`[${localesDir}] Unused keys in ${reference} (${unused.length}):`);
    for (const k of unused) console.error(`  ~ ${k}`);
    hasErrors = true;
  }

  for (const file of files) {
    if (file === reference) continue;

    const locale = file.replace('.json', '');
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
