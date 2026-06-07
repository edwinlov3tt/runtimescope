// Dashboard auth: the collector's read API + live WS require a bearer token when
// auth is active (a global RUNTIMESCOPE_AUTH_TOKEN or any workspace API key).
// The token is entered on the login screen and kept per-browser in localStorage.
// This module is dependency-free so api.ts / pm-api.ts / ws-client.ts and the
// auth store can all share it without import cycles.

const TOKEN_KEY = 'runtimescope.token';

// undefined = not yet read from storage; null = read, none present.
let cached: string | null | undefined;

export function getToken(): string | null {
  if (cached === undefined) {
    try {
      cached = localStorage.getItem(TOKEN_KEY);
    } catch {
      cached = null;
    }
  }
  return cached ?? null;
}

export function setToken(token: string): void {
  cached = token;
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* storage unavailable (private mode) — token stays in-memory for the tab */
  }
}

export function clearToken(): void {
  cached = null;
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

/** Merge an `Authorization: Bearer` header when a token is stored (else passthrough). */
export function authHeaders(base?: Record<string, string>): Record<string, string> {
  const t = getToken();
  return t ? { ...(base ?? {}), Authorization: `Bearer ${t}` } : { ...(base ?? {}) };
}

/** Append `?token=` to a WebSocket URL — browsers can't set headers on a WS. */
export function withWsToken(url: string): string {
  const t = getToken();
  if (!t) return url;
  return url + (url.includes('?') ? '&' : '?') + `token=${encodeURIComponent(t)}`;
}
