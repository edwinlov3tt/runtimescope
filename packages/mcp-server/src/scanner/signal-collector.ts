import type { Page, Response } from 'playwright';
import type { DetectionSignals, DomSignals, DomElementResult } from '@runtimescope/extension';

/**
 * Collect DetectionSignals from a Playwright page for the tech stack detection engine.
 * This runs multiple page.evaluate calls to extract all signal types.
 */
export async function collectDetectionSignals(
  page: Page,
  mainResponse: Response | null,
  jsGlobalPaths: string[],
  domSelectors: string[],
): Promise<DetectionSignals> {
  const url = page.url();

  // 1. Headers from the main document response
  const headers: Record<string, string> = {};
  if (mainResponse) {
    const allHeaders = await mainResponse.allHeaders();
    for (const [key, value] of Object.entries(allHeaders)) {
      headers[key.toLowerCase()] = value;
    }
  }

  // 2. Cookies
  const cookies: Record<string, string> = {};
  const rawCookies = await page.context().cookies();
  for (const c of rawCookies) {
    cookies[c.name] = c.value;
  }

  // 3-6: Meta tags, script srcs, inline scripts, CSS — batch in one evaluate
  const pageSignals = await page.evaluate(() => {
    // Meta tags
    const meta: Record<string, string> = {};
    document.querySelectorAll('meta[name],meta[property],meta[http-equiv]').forEach((el) => {
      const name = el.getAttribute('name') || el.getAttribute('property') || el.getAttribute('http-equiv');
      const content = el.getAttribute('content');
      if (name && content) meta[name.toLowerCase()] = content;
    });

    // Script src URLs
    const scriptSrc: string[] = [];
    document.querySelectorAll('script[src]').forEach((el) => {
      const src = el.getAttribute('src');
      if (src) scriptSrc.push(src);
    });

    // Inline script content (limited to first 500 chars each, max 50 scripts)
    const scripts: string[] = [];
    document.querySelectorAll('script:not([src])').forEach((el) => {
      const text = el.textContent?.trim();
      if (text && scripts.length < 50) {
        scripts.push(text.slice(0, 500));
      }
    });

    // CSS: custom properties from :root + <style> tag contents
    const css: string[] = [];
    const rootStyles = getComputedStyle(document.documentElement);
    const cssVarNames: string[] = [];
    for (let i = 0; i < rootStyles.length; i++) {
      const prop = rootStyles[i];
      if (prop.startsWith('--')) cssVarNames.push(prop);
    }
    if (cssVarNames.length > 0) {
      css.push(cssVarNames.map((v) => `${v}: ${rootStyles.getPropertyValue(v)}`).join('; '));
    }
    document.querySelectorAll('style').forEach((el) => {
      const text = el.textContent?.trim();
      if (text && css.length < 20) css.push(text.slice(0, 2000));
    });

    return { meta, scriptSrc, scripts, css };
  });

  // 7. HTML source (full page, limited to 50KB for pattern matching)
  const fullHtml = await page.content();
  const html = fullHtml.slice(0, 50_000);

  // 8. JS globals — evaluate a batch of known paths
  const js = await page.evaluate((paths: string[]) => {
    const results: Record<string, string> = {};
    for (const path of paths) {
      try {
        const parts = path.split('.');
        let current: unknown = window;
        for (const part of parts) {
          if (current == null) break;
          current = (current as Record<string, unknown>)[part];
        }
        if (current !== undefined) {
          results[path] = typeof current === 'string' ? current
            : typeof current === 'number' ? String(current)
            : '';
        }
      } catch {
        // Skip inaccessible properties
      }
    }
    return results;
  }, jsGlobalPaths);

  // 9. DOM selectors — batch query
  const dom = await page.evaluate((selectors: string[]) => {
    const results: Record<string, Array<{
      exists: boolean;
      attributes: Record<string, string>;
      properties: Record<string, string>;
      text: string;
    }>> = {};

    for (const selector of selectors) {
      try {
        const elements = document.querySelectorAll(selector);
        if (elements.length === 0) continue;

        const elResults: Array<{
          exists: boolean;
          attributes: Record<string, string>;
          properties: Record<string, string>;
          text: string;
        }> = [];

        // Only process first 3 matches per selector
        const limit = Math.min(elements.length, 3);
        for (let i = 0; i < limit; i++) {
          const el = elements[i];
          const attributes: Record<string, string> = {};
          for (const attr of el.attributes) {
            attributes[attr.name] = attr.value;
          }

          // Check common DOM properties used by detection
          const properties: Record<string, string> = {};
          const propsToCheck = ['_reactRootContainer', '__vue__', '__svelte', 'ng-version'];
          for (const prop of propsToCheck) {
            if (prop in el) {
              properties[prop] = String((el as unknown as Record<string, unknown>)[prop] ?? '');
            }
          }

          elResults.push({
            exists: true,
            attributes,
            properties,
            text: (el.textContent || '').trim().slice(0, 200),
          });
        }

        results[selector] = elResults;
      } catch {
        // Invalid selector or access error — skip
      }
    }

    return results;
  }, domSelectors) as DomSignals;

  return {
    url,
    headers,
    cookies,
    meta: pageSignals.meta,
    scriptSrc: pageSignals.scriptSrc,
    scripts: pageSignals.scripts,
    html,
    css: pageSignals.css,
    js,
    dom,
    // xhr: not collected in one-shot scan (would need request interception over time)
  };
}

/**
 * Extract all unique JS global paths from the technology database entries.
 */
export function extractJsGlobalPaths(
  technologies: Array<{ js?: Record<string, unknown> }>,
): string[] {
  const paths = new Set<string>();
  for (const tech of technologies) {
    if (tech.js) {
      for (const path of Object.keys(tech.js)) {
        paths.add(path);
      }
    }
  }
  return Array.from(paths);
}

/**
 * Extract all unique DOM selectors from the technology database entries.
 */
export function extractDomSelectors(
  technologies: Array<{ dom?: Record<string, unknown> }>,
): string[] {
  const selectors = new Set<string>();
  for (const tech of technologies) {
    if (tech.dom) {
      for (const selector of Object.keys(tech.dom)) {
        selectors.add(selector);
      }
    }
  }
  return Array.from(selectors);
}
