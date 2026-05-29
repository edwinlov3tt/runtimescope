import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { log } from './log.js';

/**
 * Load the technology-detection data files (`technologies.json` ~2.5 MB,
 * `categories.json` ~196 KB) that the bundled `@runtimescope/extension`
 * detection engine consumes.
 *
 * The detection CODE is bundled into the sidecar (tsup `noExternal`), but the
 * large DATA files are read from disk at runtime to keep the JS bundle small.
 * We probe a few candidate locations so the sidecar works both inside the
 * monorepo and once packaged for curl-install (Milestone 6), where the data is
 * expected to sit next to `dist/` in a sibling `data/` directory.
 */
export function loadTechData(): { techData: Record<string, never>; catData: Record<string, never> } {
  const here = dirname(fileURLToPath(import.meta.url));

  const candidates = [
    // Packaged layout (Milestone 6): data copied next to dist/.
    resolve(here, '../data'),
    // Hoisted monorepo node_modules.
    resolve(here, '../../../node_modules/@runtimescope/extension/src/data'),
    // Sibling source package inside the monorepo.
    resolve(here, '../../extension/src/data'),
  ];

  // Robust fallback: resolve the extension package directory via Node.
  // `./package.json` is exposed by the extension's `exports` map.
  try {
    const req = createRequire(import.meta.url);
    const pkgJson = req.resolve('@runtimescope/extension/package.json');
    candidates.push(resolve(dirname(pkgJson), 'src/data'));
    candidates.push(resolve(dirname(pkgJson), 'data'));
  } catch {
    // Package not resolvable (e.g. fully standalone install) — rely on the
    // path candidates above.
  }

  for (const base of candidates) {
    try {
      const techData = JSON.parse(readFileSync(resolve(base, 'technologies.json'), 'utf-8'));
      const catData = JSON.parse(readFileSync(resolve(base, 'categories.json'), 'utf-8'));
      log.error(`tech database loaded from ${base}`);
      return { techData, catData };
    } catch {
      continue;
    }
  }

  throw new Error(
    'recon-sidecar: could not load the technology database (technologies.json / categories.json). ' +
      `Searched: ${candidates.join(', ')}`,
  );
}
