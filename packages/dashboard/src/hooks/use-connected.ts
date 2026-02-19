import { useDataStore } from '@/stores/use-data-store';

/** Returns true when the dashboard has live data from the collector. */
export function useConnected(): boolean {
  const source = useDataStore((s) => s.source);
  const wsConnected = useDataStore((s) => s.connected);
  return source === 'live' && wsConnected;
}
