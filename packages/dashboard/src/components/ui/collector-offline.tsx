import { useState, useEffect } from 'react';
import { cn } from '@/lib/cn';
import { checkHealth } from '@/lib/api';
import {
  WifiOff,
  Terminal,
  Copy,
  Check,
  RefreshCw,
  Hexagon,
  ArrowRight,
} from 'lucide-react';

const STEPS = [
  {
    label: 'Install',
    command: 'npm install @runtimescope/sdk',
    description: 'Add the SDK to your project',
  },
  {
    label: 'Start collector',
    command: 'npx runtimescope',
    description: 'Start the collector server on port 6767',
  },
  {
    label: 'Initialize',
    command: "RuntimeScope.init({ appName: 'my-app' })",
    description: 'Add to your app entry point',
  },
];

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <button
      onClick={handleCopy}
      className="shrink-0 p-1 rounded hover:bg-bg-hover text-text-disabled hover:text-text-secondary transition-colors cursor-pointer"
      title="Copy to clipboard"
    >
      {copied ? <Check size={12} className="text-green" /> : <Copy size={12} />}
    </button>
  );
}

export function CollectorOffline({ onRetry }: { onRetry?: () => void }) {
  const [checking, setChecking] = useState(false);

  const handleRetry = async () => {
    setChecking(true);
    const ok = await checkHealth();
    setChecking(false);
    if (ok && onRetry) onRetry();
    if (ok) window.location.reload();
  };

  // Auto-retry every 10s
  useEffect(() => {
    const interval = setInterval(async () => {
      const ok = await checkHealth();
      if (ok) window.location.reload();
    }, 10_000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="flex-1 flex items-center justify-center bg-bg-base">
      <div className="max-w-lg w-full px-8">
        {/* Icon + status */}
        <div className="flex flex-col items-center text-center mb-10">
          <div className="relative mb-6">
            <div className="w-16 h-16 rounded-2xl bg-bg-surface border border-border-strong flex items-center justify-center">
              <Hexagon size={28} className="text-accent" />
            </div>
            <div className="absolute -bottom-1 -right-1 w-6 h-6 rounded-full bg-bg-base border-2 border-bg-base flex items-center justify-center">
              <WifiOff size={12} className="text-amber" />
            </div>
          </div>
          <h1 className="text-xl font-bold text-text-primary mb-2">Collector Offline</h1>
          <p className="text-[13px] text-text-tertiary leading-relaxed max-w-sm">
            The RuntimeScope collector isn't running. Start it to begin capturing events from your application.
          </p>
        </div>

        {/* Steps */}
        <div className="space-y-3 mb-8">
          {STEPS.map((step, i) => (
            <div key={i} className="flex items-start gap-3">
              {/* Step number */}
              <div className="w-6 h-6 rounded-full bg-accent-muted border border-accent-border flex items-center justify-center shrink-0 mt-0.5">
                <span className="text-[11px] font-bold text-accent">{i + 1}</span>
              </div>

              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-[12px] font-semibold text-text-primary">{step.label}</span>
                  <span className="text-[11px] text-text-muted">{step.description}</span>
                </div>
                <div className="flex items-center gap-2 bg-bg-surface border border-border-default rounded-md px-3 py-2">
                  <Terminal size={12} className="text-text-muted shrink-0" />
                  <code className="flex-1 text-[12px] font-mono text-accent truncate">{step.command}</code>
                  <CopyButton text={step.command} />
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Actions */}
        <div className="flex items-center gap-3">
          <button
            onClick={handleRetry}
            disabled={checking}
            className={cn(
              'flex-1 flex items-center justify-center gap-2 h-10 rounded-md text-[13px] font-semibold transition-all cursor-pointer',
              'bg-accent text-text-inverse hover:brightness-110',
              checking && 'opacity-70',
            )}
          >
            <RefreshCw size={14} className={checking ? 'animate-spin' : ''} />
            {checking ? 'Checking...' : 'Retry Connection'}
          </button>
          <a
            href="https://github.com/anthropics/runtimescope"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 h-10 px-4 rounded-md text-[13px] font-medium text-text-tertiary bg-bg-surface border border-border-default hover:border-border-hover hover:text-text-primary transition-colors"
          >
            Docs <ArrowRight size={12} />
          </a>
        </div>

        {/* Auto-retry hint */}
        <p className="text-center text-[11px] text-text-disabled mt-4">
          Auto-retrying every 10 seconds &bull; Listening on ws://localhost:6767
        </p>
      </div>
    </div>
  );
}
