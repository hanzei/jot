/**
 * Globals exposed by `jest.setup.js` to test files.
 */
declare global {
  /**
   * The in-memory filesystem backing the `expo-file-system` mock. Tests seed and
   * inspect it directly instead of stubbing individual calls, so the real
   * `src/utils/fs.ts` logic runs under test.
   */
  var mockFileSystem: {
    /** uri → file contents. */
    files: Map<string, string>;
    /** Existing directory uris. */
    dirs: Set<string>;
    /** Stubbed download; override per test to simulate failures. */
    downloadFileAsync: jest.Mock;
    /** Restore an empty filesystem with only the document and cache roots. */
    reset(): void;
  };
}

export {};
