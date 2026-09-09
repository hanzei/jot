#!/usr/bin/env node
// Checks that all locale translation files have the same keys as en.json,
// that every key in en.json is actually referenced from source, and that
// every literal key referenced from source actually exists in en.json.
// Exits with code 1 if any keys are missing, extra, unused, or undefined.

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

// @jot/shared is compiled directly by both webapp and mobile (not a build artifact), so a
// key referenced only from shared source (e.g. a hex-color -> i18n-key map used by both
// clients) would otherwise look unused from either app's own tree.
const sharedSrcDir = join(__dirname, '../../shared/src');

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

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// A plain corpus.includes(key) treats a key as "used" whenever it appears as a
// substring anywhere in source — including as a prefix of an unrelated, longer
// identifier. `note.delete` is a substring of the live field access
// `note.deleted_at`, and `share.removeAccess` is a substring of the live key
// `share.removeAccessFor`; both hid a truly dead key from this check. Requiring
// non-key characters (or start/end of file) on both sides of the match rules
// that out, since a key never appears as a strict prefix of another dotted
// identifier in valid source.
function isKeyReferenced(key, corpus) {
  const pattern = new RegExp(`(?<![\\w.])${escapeRegExp(key)}(?![\\w.])`);
  return pattern.test(corpus);
}

function buildCorpus(sourceRoot) {
  return [...collectSourceFiles(sourceRoot), ...collectSourceFiles(sharedSrcDir)]
    .map((f) => readFileSync(f, 'utf8'))
    .join('\n');
}

function findUnusedKeys(keys, corpus) {
  return keys.filter((key) => {
    if (DYNAMIC_KEY_PREFIXES.some((prefix) => key.startsWith(prefix))) return false;
    const baseKey = key.replace(PLURAL_SUFFIX, '');
    return !isKeyReferenced(key, corpus) && !isKeyReferenced(baseKey, corpus);
  });
}

// Matches literal, dotted i18n keys passed to t(): t('settings.foo'), t("note.bar"),
// including a leading whitespace/newline before the quote. Backtick template literals
// (t(`settings.language_${lang}`)) are intentionally excluded — a runtime-assembled key
// has no literal to verify — as is any t preceded by a word/`$` char (format(), etc.).
const T_CALL_KEY = /(?<![\w$])t\(\s*(['"])([\w.]+)\1/g;

// A literal key referenced from source that resolves to no key in en.json. This is the
// reverse of findUnusedKeys: it catches the typo the other direction, where the code asks
// i18next for a key that was never added to the locales (i18next then renders the raw key
// string — e.g. a settings screen showing "settings.sectionDescription" verbatim).
//
// Scoped to keys whose top-level section already exists in en.json, so an unrelated t()
// (or a genuinely new section still being wired up) is not misread as a broken key. Plural
// callers pass the base key (t('note.itemsPasted')) while en.json holds only the suffixed
// forms, so a key counts as defined if the base — with any plural suffix stripped — is
// present.
function findMissingReferencedKeys(referenceKeys, corpus) {
  const definedKeys = new Set(referenceKeys);
  for (const key of referenceKeys) definedKeys.add(key.replace(PLURAL_SUFFIX, ''));

  const sections = new Set([...referenceKeys].map((key) => key.split('.')[0]));

  const missing = new Set();
  for (const match of corpus.matchAll(T_CALL_KEY)) {
    const key = match[2];
    if (!key.includes('.')) continue;
    if (!sections.has(key.split('.')[0])) continue;
    if (DYNAMIC_KEY_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
    if (!definedKeys.has(key)) missing.add(key);
  }
  return [...missing].sort();
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

  const corpus = buildCorpus(sourceRootFor(localesDir));

  const unused = findUnusedKeys([...referenceKeys], corpus);
  if (unused.length > 0) {
    console.error(`[${localesDir}] Unused keys in ${reference} (${unused.length}):`);
    for (const k of unused) console.error(`  ~ ${k}`);
    hasErrors = true;
  }

  const undefinedKeys = findMissingReferencedKeys(referenceKeys, corpus);
  if (undefinedKeys.length > 0) {
    console.error(`[${localesDir}] Keys referenced in source but missing from ${reference} (${undefinedKeys.length}):`);
    for (const k of undefinedKeys) console.error(`  ! ${k}`);
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
