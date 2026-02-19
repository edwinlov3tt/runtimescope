import type { ActivityItem } from '@/components/ui/activity-feed';
import type {
  NetworkEvent,
  ConsoleEvent,
  StateEvent,
  RenderEvent,
  PerformanceEvent,
  DatabaseEvent,
} from '@/mock/types';

type RuntimeEvent = NetworkEvent | ConsoleEvent | StateEvent | RenderEvent | PerformanceEvent | DatabaseEvent;

export function eventsToActivity(events: RuntimeEvent[], limit = 20): ActivityItem[] {
  // Sort newest first
  const sorted = [...events].sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);

  return sorted.map((e) => {
    switch (e.eventType) {
      case 'network':
        return {
          id: e.eventId,
          type: 'network',
          message: `${e.method} ${shortUrl(e.url)} — ${e.status} (${e.duration.toFixed(0)}ms)`,
          timestamp: e.timestamp,
          meta: e.graphqlOperation ? `GraphQL ${e.graphqlOperation.name}` : undefined,
        };
      case 'console':
        return {
          id: e.eventId,
          type: 'console',
          message: e.message.slice(0, 120),
          timestamp: e.timestamp,
          meta: e.sourceFile,
        };
      case 'state':
        return {
          id: e.eventId,
          type: 'state',
          message: `${e.storeId}: ${e.action?.type || e.phase}`,
          timestamp: e.timestamp,
          meta: e.library,
        };
      case 'render':
        return {
          id: e.eventId,
          type: 'render',
          message: `${e.totalRenders} renders (${e.profiles.length} components)`,
          timestamp: e.timestamp,
          meta: e.suspiciousComponents.length > 0
            ? `Suspicious: ${e.suspiciousComponents.join(', ')}`
            : undefined,
        };
      case 'performance':
        return {
          id: e.eventId,
          type: 'performance',
          message: `${e.metricName}: ${e.value}${e.metricName === 'CLS' ? '' : 'ms'} (${e.rating})`,
          timestamp: e.timestamp,
          meta: e.element,
        };
      case 'database':
        return {
          id: e.eventId,
          type: 'database',
          message: `${e.operation} ${e.tablesAccessed.join(', ')} — ${e.duration.toFixed(0)}ms`,
          timestamp: e.timestamp,
          meta: e.source,
        };
      default:
        return {
          id: (e as any).eventId,
          type: 'network',
          message: 'Unknown event',
          timestamp: (e as any).timestamp,
        };
    }
  });
}

function shortUrl(url: string): string {
  try {
    const { pathname } = new URL(url);
    return pathname.length > 40 ? pathname.slice(0, 37) + '...' : pathname;
  } catch {
    return url.slice(0, 40);
  }
}
