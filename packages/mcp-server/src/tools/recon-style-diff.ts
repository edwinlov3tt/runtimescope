import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { EventStore } from '@runtimescope/collector';
import type { ComputedStyleEntry } from '@runtimescope/collector';

// Properties that matter most for visual fidelity
const VISUAL_PROPERTIES = [
  'color', 'background-color', 'border-color', 'border-radius',
  'font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing',
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'width', 'height', 'display', 'position', 'gap',
  'flex-direction', 'justify-content', 'align-items',
  'box-shadow', 'text-shadow', 'opacity', 'border-width', 'border-style',
  'text-align', 'text-transform', 'text-decoration', 'overflow',
  'grid-template-columns', 'grid-template-rows',
];

interface StyleDiffEntry {
  property: string;
  sourceValue: string;
  targetValue: string;
  match: boolean;
  delta?: string;  // for numeric values, the difference
}

export function registerReconStyleDiffTools(server: McpServer, store: EventStore): void {
  server.tool(
    'get_style_diff',
    'Compare computed styles between two captured element snapshots to check how closely a recreation matches the original. Compares two selectors from stored computed style events and reports property-by-property differences with a match percentage. Use this to verify UI recreation fidelity.',
    {
      source_selector: z
        .string()
        .describe('CSS selector for the source/original element'),
      target_selector: z
        .string()
        .describe('CSS selector for the target/recreation element'),
      properties: z
        .enum(['visual', 'all'])
        .optional()
        .default('visual')
        .describe('"visual" compares only visually-significant properties (colors, typography, spacing, layout). "all" compares everything.'),
      specific_properties: z
        .array(z.string())
        .optional()
        .describe('Specific CSS property names to compare (overrides properties group)'),
    },
    async ({ source_selector, target_selector, properties, specific_properties }) => {
      const events = store.getReconComputedStyles();
      const sessions = store.getSessionInfo();
      const sessionId = sessions[0]?.sessionId ?? null;

      // Find the styles for each selector
      const sourceEvent = events.find((e) =>
        e.entries.some((entry) => entry.selector === source_selector),
      );
      const targetEvent = events.find((e) =>
        e.entries.some((entry) => entry.selector === target_selector),
      );

      if (!sourceEvent || !targetEvent) {
        const missing: string[] = [];
        if (!sourceEvent) missing.push(`source "${source_selector}"`);
        if (!targetEvent) missing.push(`target "${target_selector}"`);

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              summary: `Missing computed styles for ${missing.join(' and ')}. Capture computed styles for both selectors first using get_computed_styles with force_refresh=true.`,
              data: null,
              issues: [`No captured styles for: ${missing.join(', ')}`],
              metadata: { timeRange: { from: 0, to: 0 }, eventCount: 0, sessionId },
            }, null, 2),
          }],
        };
      }

      const sourceEntry = sourceEvent.entries.find((e) => e.selector === source_selector)!;
      const targetEntry = targetEvent.entries.find((e) => e.selector === target_selector)!;

      // Determine which properties to compare
      let propsToCompare: string[];
      if (specific_properties && specific_properties.length > 0) {
        propsToCompare = specific_properties;
      } else if (properties === 'visual') {
        propsToCompare = VISUAL_PROPERTIES;
      } else {
        // All properties present in either source or target
        propsToCompare = Array.from(
          new Set([...Object.keys(sourceEntry.styles), ...Object.keys(targetEntry.styles)]),
        );
      }

      // Compare
      const diffs: StyleDiffEntry[] = [];
      let matchCount = 0;
      let diffCount = 0;

      for (const prop of propsToCompare) {
        const sourceVal = sourceEntry.styles[prop] ?? '(not set)';
        const targetVal = targetEntry.styles[prop] ?? '(not set)';
        const match = normalizeValue(sourceVal) === normalizeValue(targetVal);

        if (match) matchCount++;
        else diffCount++;

        const entry: StyleDiffEntry = { property: prop, sourceValue: sourceVal, targetValue: targetVal, match };

        // Calculate numeric delta for px/rem/em values
        if (!match) {
          const sourceNum = parseNumericValue(sourceVal);
          const targetNum = parseNumericValue(targetVal);
          if (sourceNum !== null && targetNum !== null) {
            const diff = targetNum - sourceNum;
            entry.delta = `${diff > 0 ? '+' : ''}${diff.toFixed(1)}px`;
          }
        }

        diffs.push(entry);
      }

      const matchPercentage = propsToCompare.length > 0
        ? Math.round((matchCount / propsToCompare.length) * 100)
        : 100;

      const issues: string[] = [];
      // Highlight the most significant differences
      const significantDiffs = diffs.filter((d) => !d.match);
      if (significantDiffs.length > 0) {
        const topDiffs = significantDiffs.slice(0, 10);
        for (const d of topDiffs) {
          issues.push(`${d.property}: "${d.sourceValue}" → "${d.targetValue}"${d.delta ? ` (${d.delta})` : ''}`);
        }
        if (significantDiffs.length > 10) {
          issues.push(`...and ${significantDiffs.length - 10} more differences.`);
        }
      }

      const response = {
        summary: `Style comparison: ${matchPercentage}% match (${matchCount}/${propsToCompare.length} properties). ${diffCount} difference(s) between "${source_selector}" and "${target_selector}".`,
        data: {
          sourceSelector: source_selector,
          targetSelector: target_selector,
          matchPercentage,
          totalProperties: propsToCompare.length,
          matches: matchCount,
          differences: diffCount,
          diffs: diffs.filter((d) => !d.match),  // Only return differences
          matchingProperties: diffs.filter((d) => d.match).map((d) => d.property),
        },
        issues,
        metadata: {
          timeRange: {
            from: Math.min(sourceEvent.timestamp, targetEvent.timestamp),
            to: Math.max(sourceEvent.timestamp, targetEvent.timestamp),
          },
          eventCount: 2,
          sessionId,
        },
      };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }],
      };
    },
  );
}

function normalizeValue(value: string): string {
  // Normalize whitespace and case for comparison
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function parseNumericValue(value: string): number | null {
  const match = value.match(/^(-?[\d.]+)\s*(px|rem|em|%)$/);
  if (!match) return null;
  const num = parseFloat(match[1]);
  // Convert rem/em to px approximation (assume 16px base)
  const unit = match[2];
  if (unit === 'rem' || unit === 'em') return num * 16;
  return num;
}
