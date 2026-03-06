import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import type { PmSession } from './pm-types.js';

// ============================================================
// Model pricing in microdollars per million tokens
// ============================================================

export const MODEL_PRICING: Record<string, { input: number; output: number; cacheWrite: number; cacheRead: number }> = {
  'claude-opus-4-6':     { input: 15_000_000, output: 75_000_000, cacheWrite: 18_750_000, cacheRead: 1_500_000 },
  'claude-sonnet-4-6':   { input: 3_000_000,  output: 15_000_000, cacheWrite: 3_750_000,  cacheRead: 300_000 },
  'claude-sonnet-4-5':   { input: 3_000_000,  output: 15_000_000, cacheWrite: 3_750_000,  cacheRead: 300_000 },
  'claude-haiku-4-5':    { input: 800_000,    output: 4_000_000,  cacheWrite: 1_000_000,  cacheRead: 80_000 },
  'claude-haiku-3-5':    { input: 800_000,    output: 4_000_000,  cacheWrite: 1_000_000,  cacheRead: 80_000 },
};

// ============================================================
// Types
// ============================================================

export interface ParseResult {
  session: Partial<PmSession>;
  messageTimestamps: number[];
}

// ============================================================
// Active time calculation
// ============================================================

/**
 * Sum gaps between consecutive timestamps where gap < idle threshold.
 * Returns total active time in minutes.
 */
export function calculateActiveMinutes(timestamps: number[], idleThresholdMs = 900_000): number {
  if (timestamps.length < 2) return 0;

  const sorted = [...timestamps].sort((a, b) => a - b);
  let activeMs = 0;

  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i] - sorted[i - 1];
    if (gap < idleThresholdMs) {
      activeMs += gap;
    }
  }

  return activeMs / 60_000;
}

// ============================================================
// Cost calculation
// ============================================================

/**
 * Fuzzy-match a model string to a pricing entry.
 * Strips date suffixes (e.g., "claude-sonnet-4-20250514" → "claude-sonnet-4")
 * and tries progressively shorter prefixes.
 */
function lookupPricing(model: string): { input: number; output: number; cacheWrite: number; cacheRead: number } | undefined {
  // Direct match first
  if (MODEL_PRICING[model]) return MODEL_PRICING[model];

  // Strip date suffix pattern (e.g., -20250514, -20250805)
  const stripped = model.replace(/-\d{8}$/, '');
  if (MODEL_PRICING[stripped]) return MODEL_PRICING[stripped];

  // Try matching by key prefix — find the longest matching key
  const keys = Object.keys(MODEL_PRICING);
  let bestMatch: string | undefined;
  let bestLen = 0;
  for (const key of keys) {
    if (stripped.startsWith(key) && key.length > bestLen) {
      bestMatch = key;
      bestLen = key.length;
    }
  }
  if (bestMatch) return MODEL_PRICING[bestMatch];

  // Reverse: key starts with stripped model name
  for (const key of keys) {
    if (key.startsWith(stripped) && key.length > bestLen) {
      bestMatch = key;
      bestLen = key.length;
    }
  }
  if (bestMatch) return MODEL_PRICING[bestMatch];

  return undefined;
}

/**
 * Calculate cost in microdollars from token counts and model name.
 * Formula: (input * pricing.input + output * pricing.output
 *           + cacheCreation * pricing.cacheWrite + cacheRead * pricing.cacheRead) / 1_000_000
 */
export function calculateCostMicrodollars(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheCreationTokens: number,
  cacheReadTokens: number,
): number {
  const pricing = lookupPricing(model);
  if (!pricing) return 0;

  return Math.round(
    (inputTokens * pricing.input
      + outputTokens * pricing.output
      + cacheCreationTokens * pricing.cacheWrite
      + cacheReadTokens * pricing.cacheRead)
    / 1_000_000,
  );
}

// ============================================================
// JSONL stream parser
// ============================================================

/**
 * Parse an ISO 8601 timestamp or epoch-ms number into epoch milliseconds.
 * Returns 0 if unparseable.
 */
function parseTimestamp(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? 0 : ms;
  }
  return 0;
}

/**
 * Extract text content from a message's content field.
 * Content can be a plain string or an array of content blocks.
 */
function extractTextContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (typeof block === 'object' && block !== null && (block as Record<string, unknown>).type === 'text') {
        const text = (block as Record<string, unknown>).text;
        if (typeof text === 'string') return text;
      }
    }
  }
  return '';
}

/**
 * Stream-parse a Claude Code session JSONL file and extract metadata.
 *
 * Uses Node.js readline + createReadStream for memory-safe line-by-line
 * parsing of files up to ~192 MB. Each line is independently JSON.parse'd;
 * malformed lines are silently skipped.
 */
export async function parseSessionJsonl(
  jsonlPath: string,
  sessionId: string,
  projectId: string,
): Promise<ParseResult> {
  const session: Partial<PmSession> = {
    id: sessionId,
    projectId,
    jsonlPath,
    messageCount: 0,
    userMessageCount: 0,
    assistantMessageCount: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheCreationTokens: 0,
    totalCacheReadTokens: 0,
    costMicrodollars: 0,
    activeMinutes: 0,
    compactionCount: 0,
  };

  const messageTimestamps: number[] = [];
  let firstHumanSeen = false;
  let earliestTs = Infinity;
  let latestTs = 0;

  const rl = createInterface({
    input: createReadStream(jsonlPath, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    // Skip empty lines
    if (!line.trim()) continue;

    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line);
    } catch {
      // Malformed line — skip
      continue;
    }

    if (typeof obj !== 'object' || obj === null) continue;

    const type = obj.type as string | undefined;
    const ts = parseTimestamp(obj.timestamp);

    // Collect timestamp for active-time calculation
    if (ts > 0) {
      messageTimestamps.push(ts);
      if (ts < earliestTs) earliestTs = ts;
      if (ts > latestTs) latestTs = ts;
    }

    // ---- Extract session-level metadata (from any message) ----

    if (!session.version && typeof obj.version === 'string') {
      session.version = obj.version;
    }
    if (!session.slug && typeof obj.slug === 'string') {
      session.slug = obj.slug;
    }
    if (!session.gitBranch && typeof obj.gitBranch === 'string') {
      session.gitBranch = obj.gitBranch;
    }
    if (!session.permissionMode && typeof obj.permissionMode === 'string') {
      session.permissionMode = obj.permissionMode;
    }

    // ---- Handle by message type ----

    if (type === 'user') {
      session.messageCount = (session.messageCount ?? 0) + 1;

      // Only count real user messages (not tool-use results) for userMessageCount
      if (!obj.toolUseResult) {
        session.userMessageCount = (session.userMessageCount ?? 0) + 1;

        // Extract first real human prompt
        if (!firstHumanSeen) {
          firstHumanSeen = true;
          const msg = obj.message as Record<string, unknown> | undefined;
          if (msg) {
            const text = extractTextContent(msg.content);
            if (text) {
              session.firstPrompt = text.slice(0, 500);
            }
          }
        }
      }
    } else if (type === 'assistant') {
      session.messageCount = (session.messageCount ?? 0) + 1;
      session.assistantMessageCount = (session.assistantMessageCount ?? 0) + 1;

      const msg = obj.message as Record<string, unknown> | undefined;

      // Extract model
      const model = (msg?.model ?? obj.model) as string | undefined;
      if (model && typeof model === 'string') {
        // Use the last model seen as the session's model
        session.model = model;
      }

      // Extract token usage
      const usage = (msg?.usage ?? obj.usage) as Record<string, unknown> | undefined;
      if (usage && typeof usage === 'object') {
        const inputTokens = typeof usage.input_tokens === 'number' ? usage.input_tokens : 0;
        const outputTokens = typeof usage.output_tokens === 'number' ? usage.output_tokens : 0;
        const cacheCreation = typeof usage.cache_creation_input_tokens === 'number'
          ? usage.cache_creation_input_tokens : 0;
        const cacheRead = typeof usage.cache_read_input_tokens === 'number'
          ? usage.cache_read_input_tokens : 0;

        session.totalInputTokens = (session.totalInputTokens ?? 0) + inputTokens;
        session.totalOutputTokens = (session.totalOutputTokens ?? 0) + outputTokens;
        session.totalCacheCreationTokens = (session.totalCacheCreationTokens ?? 0) + cacheCreation;
        session.totalCacheReadTokens = (session.totalCacheReadTokens ?? 0) + cacheRead;

        // Calculate incremental cost if we have a model
        if (model) {
          session.costMicrodollars = (session.costMicrodollars ?? 0)
            + calculateCostMicrodollars(model, inputTokens, outputTokens, cacheCreation, cacheRead);
        }
      }
    } else if (type === 'summary') {
      // Compaction summary — appears at the start of compacted sessions
      session.compactionCount = (session.compactionCount ?? 0) + 1;
      if (!session.summary && typeof obj.summary === 'string') {
        session.summary = obj.summary;
      }
    } else if (type === 'system') {
      session.messageCount = (session.messageCount ?? 0) + 1;

      // Detect compaction events via subtype or content
      const subtype = obj.subtype as string | undefined;
      if (subtype === 'compact_boundary') {
        session.compactionCount = (session.compactionCount ?? 0) + 1;

        // Extract pre-compaction token count
        const meta = obj.compactMetadata as Record<string, unknown> | undefined;
        if (meta) {
          const preTokens = typeof meta.preTokens === 'string'
            ? parseInt(meta.preTokens, 10)
            : typeof meta.preTokens === 'number' ? meta.preTokens : undefined;
          if (preTokens && !Number.isNaN(preTokens)) {
            session.preCompactionTokens = preTokens;
          }
        }
      } else {
        // Check content for compaction keywords
        const content = typeof obj.content === 'string' ? obj.content : '';
        if (content.toLowerCase().includes('compact')) {
          session.compactionCount = (session.compactionCount ?? 0) + 1;
        }
      }
    }

    // ---- Direct cost fields on any line ----
    const directCost = obj.costUSD ?? obj.cost_usd;
    if (typeof directCost === 'number') {
      // costUSD is in dollars; convert to microdollars and add
      session.costMicrodollars = (session.costMicrodollars ?? 0) + Math.round(directCost * 1_000_000);
    }
  }

  // ---- Finalize session metadata ----

  if (earliestTs < Infinity) {
    session.startedAt = earliestTs;
  }
  if (latestTs > 0) {
    session.endedAt = latestTs;
  }
  // Don't fallback to Date.now() here — let the caller provide a better
  // fallback (e.g. file mtime) so sessions aren't all stamped "today"

  // Calculate active minutes from collected timestamps
  session.activeMinutes = calculateActiveMinutes(messageTimestamps);

  // Set audit timestamps
  const now = Date.now();
  session.createdAt = session.startedAt ?? now;
  session.updatedAt = now;

  return { session, messageTimestamps };
}
