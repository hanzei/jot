import hljs from 'highlight.js/lib/core';
import type { LanguageFn } from 'highlight.js';
import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import go from 'highlight.js/lib/languages/go';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import python from 'highlight.js/lib/languages/python';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';
import { HIGHLIGHT_LANGUAGES, type CodeHighlighter, type HighlightLanguage } from '@jot/shared';

// This client's highlight.js instance. Which languages exist, what their tokens
// are called and how they are coloured is decided in shared/src/codeHighlight.ts;
// shared/ cannot import highlight.js itself, so each client builds the instance
// and hands it over — mobile/src/utils/codeHighlighter.ts is the same file.
//
// Keyed by the shared list, so a language added there fails to compile here
// until its grammar is imported. Only `lib/core` plus these grammars ship; the
// full `highlight.js` entry point would pull in all ~190.

const GRAMMARS: Record<HighlightLanguage, LanguageFn> = {
  bash, css, go, javascript, json, python, sql, typescript, xml, yaml,
};

function createHighlighter(): CodeHighlighter {
  // A private instance rather than the global one, so nothing else registering
  // a language can widen what notes highlight.
  const instance = hljs.newInstance();
  for (const name of HIGHLIGHT_LANGUAGES) instance.registerLanguage(name, GRAMMARS[name]);
  return instance;
}

export const codeHighlighter = createHighlighter();
