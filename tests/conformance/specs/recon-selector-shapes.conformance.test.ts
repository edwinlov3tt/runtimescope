/**
 * Conformance: the SELECTOR-recon tools (get_computed_styles / get_element_snapshot)
 * reshaping path, against Node.
 *
 * These two tools have two paths (recon-computed-styles.ts / recon-element-snapshot.ts):
 *   1. Reshape a stored/cached `recon_computed_styles` / `recon_element_snapshot`
 *      event (property-group filtering, variations issues, snapshot summary).
 *   2. Live sidecar capture against the last-scanned URL when nothing is stored
 *      (needs a real browser — verified manually like scan_website, NOT here).
 *
 * This spec pins path (1) — the reshaping — by injecting synthetic recon events
 * (as the extension/scanner-cache would) and asserting the Node-parity output:
 * property-group/specific filtering, the variations issue, propertyFilter echo,
 * the snapshot summary string, and the zero-dimension issue.
 *
 * Separate `it` blocks; green vs Node first, RUNTIMESCOPE_MCP_CMD swaps Rust.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { McpDriver, SdkDriver } from '../harness/index.js';

let mcp: McpDriver | null = null;
afterEach(async () => { await mcp?.stop(); mcp = null; });

const PROJECT = 'proj_recon_selector';
const APP = 'recon-selector';

function computedStylesEvent(sessionId: string): object {
  return {
    eventId: 'evt-cs-1',
    sessionId,
    timestamp: Date.now(),
    eventType: 'recon_computed_styles',
    url: 'https://x.test/page',
    selector: '.btn',
    entries: [
      {
        selector: '.btn',
        matchCount: 2,
        styles: {
          'color': 'rgb(0, 0, 0)',
          'background-color': 'rgb(255, 255, 255)',
          'font-size': '16px',
          'margin-top': '8px',
        },
        variations: [
          { property: 'color', values: [{ value: 'rgb(0, 0, 0)', count: 1 }, { value: 'rgb(1, 1, 1)', count: 1 }] },
        ],
      },
    ],
  };
}

function elementSnapshotEvent(sessionId: string, selector: string, w: number, h: number): object {
  return {
    eventId: `evt-es-${selector}`,
    sessionId,
    timestamp: Date.now(),
    eventType: 'recon_element_snapshot',
    url: 'https://x.test/page',
    selector,
    depth: 5,
    totalNodes: 1,
    root: {
      tag: 'div',
      id: 'hero',
      classList: ['card'],
      attributes: {},
      textContent: 'hi',
      boundingRect: { x: 0, y: 0, width: w, height: h },
      computedStyles: {},
      children: [],
    },
  };
}

describe('MCP selector-recon reshaping (Node)', () => {
  it('get_computed_styles filters by group/specific props, echoes propertyFilter, and flags variations', async () => {
    mcp = McpDriver.spawn();
    await mcp.ready();
    const d = new SdkDriver({ wsPort: mcp.wsPort, appName: APP, projectId: PROJECT });
    await d.connect();
    await new Promise((r) => setTimeout(r, 150));
    d.sendBatch([computedStylesEvent(d.sessionId)]);
    await d.flush();
    await new Promise((r) => setTimeout(r, 600));

    // properties = 'all' (default): all 4 styles, propertyFilter echoes "all".
    {
      const { envelope } = await mcp.callTool('get_computed_styles', { project_id: PROJECT, selector: '.btn' });
      const env = envelope as {
        summary: string;
        data: { selector: string; propertyFilter: unknown; entries: Array<{ selector: string; matchCount: number; styles: Record<string, string>; variations: unknown[] }> };
        issues: string[];
      };
      expect(env.data.entries.length).toBe(1);
      expect(Object.keys(env.data.entries[0].styles).length).toBe(4);
      expect(env.data.propertyFilter).toBe('all');
      expect(env.data.entries[0].matchCount).toBe(2);
      expect(env.summary).toBe('1 element(s) matched ".btn". 4 CSS properties returned.');
      // The single variation surfaces an issue with matchCount + selector.
      expect(env.issues).toContain('1 property variation(s) across 2 matching elements for ".btn".');
    }

    // properties = 'colors': only color/background-color survive the group filter.
    {
      const { envelope } = await mcp.callTool('get_computed_styles', { project_id: PROJECT, selector: '.btn', properties: 'colors' });
      const env = envelope as { summary: string; data: { propertyFilter: unknown; entries: Array<{ styles: Record<string, string> }> } };
      const styles = env.data.entries[0].styles;
      expect(Object.keys(styles).sort()).toEqual(['background-color', 'color']);
      expect(env.data.propertyFilter).toBe('colors');
      expect(env.summary).toBe('1 element(s) matched ".btn". 2 CSS properties returned (colors group).');
    }

    // specific_properties overrides the group; propertyFilter echoes the array.
    {
      const { envelope } = await mcp.callTool('get_computed_styles', { project_id: PROJECT, selector: '.btn', specific_properties: ['font-size'] });
      const env = envelope as { summary: string; data: { propertyFilter: unknown; entries: Array<{ styles: Record<string, string> }> } };
      expect(Object.keys(env.data.entries[0].styles)).toEqual(['font-size']);
      expect(env.data.propertyFilter).toEqual(['font-size']);
      expect(env.summary).toBe('1 element(s) matched ".btn". 1 CSS properties returned.');
    }

    await d.close();
  });

  it('get_element_snapshot summarizes the node tree and flags zero-dimension roots', async () => {
    mcp = McpDriver.spawn();
    await mcp.ready();
    const d = new SdkDriver({ wsPort: mcp.wsPort, appName: APP, projectId: PROJECT });
    await d.connect();
    await new Promise((r) => setTimeout(r, 150));
    d.sendBatch([
      elementSnapshotEvent(d.sessionId, '.card', 300, 200),
      elementSnapshotEvent(d.sessionId, '.hidden', 0, 0),
    ]);
    await d.flush();
    await new Promise((r) => setTimeout(r, 600));

    // Normal element: summary reports nodes/depth/tag/dimensions; no issue.
    {
      const { envelope } = await mcp.callTool('get_element_snapshot', { project_id: PROJECT, selector: '.card' });
      const env = envelope as { summary: string; data: { selector: string; depth: number; totalNodes: number; root: { tag: string } }; issues: string[] };
      expect(env.data.totalNodes).toBe(1);
      expect(env.data.depth).toBe(5);
      expect(env.data.root.tag).toBe('div');
      expect(env.summary).toBe('Element snapshot for ".card": 1 nodes captured to depth 5. Root is <div> at 300x200px.');
      expect(env.issues.length).toBe(0);
    }

    // Zero-dimension root → a "may be hidden" issue.
    {
      const { envelope } = await mcp.callTool('get_element_snapshot', { project_id: PROJECT, selector: '.hidden' });
      const env = envelope as { issues: string[] };
      expect(env.issues).toContain('Root element ".hidden" has zero dimensions (0x0). It may be hidden.');
    }

    await d.close();
  });
});
