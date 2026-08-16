/**
 * Ambient declarations for the runtime surface shared/src actually relies on,
 * beyond what "lib": ["ES2020"] provides. Deliberately narrow: shared/src runs
 * on both the browser and Hermes (React Native), so it must not assume DOM.
 */

/** WHATWG URL parser. Available in both the browser and Hermes. */
declare class URL {
  constructor(url: string, base?: string | URL);
  protocol: string;
  hostname: string;
  port: string;
  toString(): string;
}

interface Crypto {
  getRandomValues<T extends ArrayBufferView>(array: T): T;
}

declare var crypto: Crypto | undefined;
