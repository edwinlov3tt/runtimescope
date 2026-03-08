// Probes whether better-sqlite3 is available at runtime.
// Returns false if the native module failed to compile or load.

import { createRequire } from 'node:module';

let _checked = false;
let _available = false;

export function isSqliteAvailable(): boolean {
  if (_checked) return _available;
  _checked = true;

  try {
    const require = createRequire(import.meta.url);
    require('better-sqlite3');
    _available = true;
  } catch {
    _available = false;
    console.error(
      '[RuntimeScope] better-sqlite3 is not available — running in memory-only mode.\n' +
      '[RuntimeScope] Historical data persistence is disabled. To fix this:\n' +
      '[RuntimeScope]   macOS:   xcode-select --install\n' +
      '[RuntimeScope]   Ubuntu:  sudo apt-get install build-essential python3\n' +
      '[RuntimeScope]   Windows: npm install --global windows-build-tools\n' +
      '[RuntimeScope] Then run: npm rebuild better-sqlite3'
    );
  }

  return _available;
}
