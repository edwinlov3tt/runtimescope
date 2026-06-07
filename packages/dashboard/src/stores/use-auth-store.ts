import { create } from 'zustand';
import { getToken, setToken, clearToken } from '@/lib/auth';

// Drives the login gate. `required` comes from /api/health (authRequired);
// `authed` means we hold a token the collector accepts. Kept separate from the
// collector-offline path (that's useDataStore.source/connected).
interface AuthState {
  required: boolean; // collector requires a token
  authed: boolean; // we hold a token the collector accepts (or auth is off)
  ready: boolean; // initial bootstrap finished
  error: string | null;
  /** Check /api/health for authRequired, then validate any stored token. */
  bootstrap: () => Promise<void>;
  /** Validate + persist a token entered on the login screen. */
  login: (token: string) => Promise<boolean>;
  logout: () => void;
  /** Called by api/pm-api on any 401 — drop the bad token, re-show login. */
  markUnauthorized: () => void;
}

// Validate a token against a gated read endpoint (no side effects).
async function tokenWorks(token: string): Promise<boolean> {
  try {
    const res = await fetch('/api/projects', { headers: { Authorization: `Bearer ${token}` } });
    return res.ok;
  } catch {
    return false;
  }
}

export const useAuthStore = create<AuthState>((set) => ({
  required: false,
  authed: false,
  ready: false,
  error: null,

  bootstrap: async () => {
    let required = false;
    try {
      const res = await fetch('/api/health');
      if (res.ok) {
        const j = await res.json();
        required = !!j.authRequired;
      }
    } catch {
      // Collector offline — the offline screen handles this; don't gate on auth.
    }
    if (!required) {
      set({ required: false, authed: true, ready: true });
      return;
    }
    const tok = getToken();
    const authed = tok ? await tokenWorks(tok) : false;
    if (!authed) clearToken();
    set({ required: true, authed, ready: true });
  },

  login: async (token) => {
    const t = token.trim();
    if (!t) {
      set({ error: 'Enter a token' });
      return false;
    }
    if (await tokenWorks(t)) {
      setToken(t);
      set({ authed: true, error: null });
      return true;
    }
    set({ error: 'That token was rejected by the collector' });
    return false;
  },

  logout: () => {
    clearToken();
    set({ authed: false });
  },

  markUnauthorized: () => {
    clearToken();
    set({ required: true, authed: false });
  },
}));
