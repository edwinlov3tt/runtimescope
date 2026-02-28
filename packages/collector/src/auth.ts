import { randomBytes, timingSafeEqual } from 'node:crypto';

// ============================================================
// API Key Authentication
// Validates SDK and HTTP API connections via bearer tokens
// ============================================================

export interface ApiKeyEntry {
  key: string;
  label: string;
  project?: string;
  createdAt: number;
}

export interface AuthConfig {
  enabled: boolean;
  apiKeys: ApiKeyEntry[];
}

export class AuthManager {
  private keys: Map<string, ApiKeyEntry> = new Map();
  private enabled: boolean;

  constructor(config: Partial<AuthConfig> = {}) {
    this.enabled = config.enabled ?? false;
    for (const entry of config.apiKeys ?? []) {
      this.keys.set(entry.key, entry);
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** Validate an API key. Returns the entry if valid, null if invalid. */
  validate(key: string | undefined): ApiKeyEntry | null {
    if (!this.enabled) return null; // auth disabled — everything passes
    if (!key) return null;

    for (const [storedKey, entry] of this.keys) {
      if (this.safeCompare(key, storedKey)) {
        return entry;
      }
    }
    return null;
  }

  /** Check if request is authorized. Returns true if auth is disabled or key is valid. */
  isAuthorized(key: string | undefined): boolean {
    if (!this.enabled) return true;
    return this.validate(key) !== null;
  }

  /** Extract bearer token from Authorization header value. */
  static extractBearer(header: string | undefined): string | undefined {
    if (!header) return undefined;
    const match = header.match(/^Bearer\s+(\S+)$/i);
    return match?.[1];
  }

  /** Constant-time string comparison to prevent timing attacks. */
  private safeCompare(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    try {
      return timingSafeEqual(Buffer.from(a, 'utf-8'), Buffer.from(b, 'utf-8'));
    } catch {
      return false;
    }
  }
}

/** Generate a cryptographically secure API key (64 hex chars = 32 bytes). */
export function generateApiKey(label: string, project?: string): ApiKeyEntry {
  return {
    key: randomBytes(32).toString('hex'),
    label,
    project,
    createdAt: Date.now(),
  };
}
