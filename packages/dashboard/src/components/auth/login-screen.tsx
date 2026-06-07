import { useState } from 'react';
import { cn } from '@/lib/cn';
import { useAuthStore } from '@/stores/use-auth-store';
import { Hexagon, Lock, ArrowRight } from 'lucide-react';

/**
 * Shown when /api/health reports authRequired and we don't hold a valid token.
 * The token is the collector's RUNTIMESCOPE_AUTH_TOKEN or a workspace API key;
 * it's validated against a gated endpoint and kept per-browser in localStorage.
 */
export function LoginScreen() {
  const login = useAuthStore((s) => s.login);
  const error = useAuthStore((s) => s.error);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token.trim() || busy) return;
    setBusy(true);
    await login(token);
    setBusy(false);
  };

  return (
    <div className="flex-1 min-h-screen flex items-center justify-center bg-bg-base">
      <form onSubmit={submit} className="max-w-sm w-full px-8">
        <div className="flex flex-col items-center text-center mb-8">
          <div className="relative mb-6">
            <div className="w-16 h-16 rounded-2xl bg-bg-surface border border-border-strong flex items-center justify-center">
              <Hexagon size={28} className="text-accent" />
            </div>
            <div className="absolute -bottom-1 -right-1 w-6 h-6 rounded-full bg-bg-base border-2 border-bg-base flex items-center justify-center">
              <Lock size={12} className="text-amber" />
            </div>
          </div>
          <h1 className="text-xl font-bold text-text-primary mb-2">Access token required</h1>
          <p className="text-[13px] text-text-tertiary leading-relaxed max-w-xs">
            This collector has authentication enabled. Enter its access token to view the dashboard.
          </p>
        </div>

        <input
          type="password"
          autoFocus
          autoComplete="current-password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="Access token"
          className={cn(
            'w-full h-10 px-3 rounded-md bg-bg-input border text-[13px] font-mono text-text-primary',
            'placeholder:text-text-disabled focus:outline-none transition-colors',
            error ? 'border-red' : 'border-border-default focus:border-border-hover',
          )}
        />
        {error && <p className="text-[12px] text-red mt-2">{error}</p>}

        <button
          type="submit"
          disabled={busy || !token.trim()}
          className={cn(
            'mt-4 w-full flex items-center justify-center gap-2 h-10 rounded-md text-[13px] font-semibold transition-all',
            'bg-accent text-text-inverse hover:brightness-110 cursor-pointer',
            (busy || !token.trim()) && 'opacity-60 cursor-not-allowed',
          )}
        >
          {busy ? 'Checking…' : 'Unlock'}
          {!busy && <ArrowRight size={14} />}
        </button>

        <p className="text-center text-[11px] text-text-disabled mt-4 leading-relaxed">
          Use the collector's <code className="font-mono text-text-muted">RUNTIMESCOPE_AUTH_TOKEN</code> or a workspace API key.
        </p>
      </form>
    </div>
  );
}
