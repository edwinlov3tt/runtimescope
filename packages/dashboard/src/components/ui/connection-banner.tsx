import { WifiOff } from 'lucide-react';
import { useDataStore } from '@/stores/use-data-store';

export function ConnectionBanner() {
  const connected = useDataStore((s) => s.connected);

  if (connected) return null;

  return (
    <div className="bg-amber-muted border-b border-amber-border px-4 py-2 flex items-center justify-center gap-2 text-amber text-xs font-medium">
      <WifiOff className="w-3.5 h-3.5" />
      <span>Connection lost — reconnecting. Data may be stale.</span>
      <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber animate-pulse-dot" />
    </div>
  );
}
