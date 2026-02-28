import type { RuntimeEvent } from './types.js';

// ============================================================
// Payload Redaction Engine
// Defense-in-depth: redacts PII/secrets from events at the
// collector level (supplements SDK-side beforeSend)
// ============================================================

export interface RedactionRule {
  name: string;
  pattern: RegExp;
  replacement: string;
}

export interface RedactorConfig {
  enabled?: boolean;
  useBuiltIn?: boolean;
  rules?: RedactionRule[];
  /** Redact JSON object keys matching these patterns (case-insensitive). */
  sensitiveKeys?: string[];
}

/** Built-in patterns for common secret/PII formats. */
export const BUILT_IN_RULES: RedactionRule[] = [
  {
    name: 'jwt',
    pattern: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+/g,
    replacement: '[REDACTED:jwt]',
  },
  {
    name: 'credit_card',
    pattern: /\b\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/g,
    replacement: '[REDACTED:cc]',
  },
  {
    name: 'ssn',
    pattern: /\b\d{3}-\d{2}-\d{4}\b/g,
    replacement: '[REDACTED:ssn]',
  },
  {
    name: 'email',
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z]{2,}\b/gi,
    replacement: '[REDACTED:email]',
  },
  {
    name: 'bearer_token',
    pattern: /Bearer\s+[A-Za-z0-9._~+/=-]+/gi,
    replacement: 'Bearer [REDACTED]',
  },
  {
    name: 'api_key_param',
    pattern: /(?:api[_-]?key|apikey|secret|token|password|passwd|authorization)=[^&\s"']+/gi,
    replacement: '[REDACTED:param]',
  },
];

/** Default sensitive JSON keys — values for these keys get redacted. */
const DEFAULT_SENSITIVE_KEYS = [
  'password', 'passwd', 'secret', 'token', 'accessToken', 'refreshToken',
  'apiKey', 'api_key', 'authorization', 'credit_card', 'creditCard',
  'ssn', 'socialSecurity',
];

export class Redactor {
  private rules: RedactionRule[];
  private sensitiveKeyPattern: RegExp | null;
  private enabled: boolean;

  constructor(config: RedactorConfig = {}) {
    this.enabled = config.enabled ?? true;
    this.rules = [];

    if (config.useBuiltIn !== false) {
      this.rules.push(...BUILT_IN_RULES);
    }
    if (config.rules) {
      this.rules.push(...config.rules);
    }

    const keys = config.sensitiveKeys ?? DEFAULT_SENSITIVE_KEYS;
    this.sensitiveKeyPattern = keys.length > 0
      ? new RegExp(`^(${keys.join('|')})$`, 'i')
      : null;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** Apply all redaction rules to a string value. */
  redactString(value: string): string {
    let result = value;
    for (const rule of this.rules) {
      // Reset lastIndex for global regexes
      rule.pattern.lastIndex = 0;
      result = result.replace(rule.pattern, rule.replacement);
    }
    return result;
  }

  /**
   * Deep-walk an event and redact all string fields.
   * Returns a new event object (does not mutate the original).
   */
  redactEvent(event: RuntimeEvent): RuntimeEvent {
    if (!this.enabled) return event;
    return this.deepRedact(event) as RuntimeEvent;
  }

  private deepRedact(value: unknown, key?: string): unknown {
    if (value === null || value === undefined) return value;

    // If this key is a known sensitive field, redact the entire value
    if (key && this.sensitiveKeyPattern?.test(key)) {
      return '[REDACTED]';
    }

    if (typeof value === 'string') {
      return this.redactString(value);
    }

    if (Array.isArray(value)) {
      return value.map((item) => this.deepRedact(item));
    }

    if (typeof value === 'object') {
      const result: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) {
        result[k] = this.deepRedact(v, k);
      }
      return result;
    }

    // numbers, booleans — pass through
    return value;
  }
}
