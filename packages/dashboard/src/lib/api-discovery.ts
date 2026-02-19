/**
 * Simplified browser port of packages/collector/src/engines/api-discovery.ts
 * Pure functions over NetworkEvent arrays.
 */
import type { NetworkEvent, ApiEndpoint, ApiEndpointHealth, ServiceInfo } from '@/mock/types';

// --- URL Normalization ---

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMERIC_RE = /^\d+$/;
const MONGO_ID_RE = /^[0-9a-f]{24}$/i;

function normalizeSegment(segment: string): string {
  if (UUID_RE.test(segment)) return ':id';
  if (NUMERIC_RE.test(segment)) return ':id';
  if (MONGO_ID_RE.test(segment)) return ':id';
  return segment;
}

function normalizeUrl(url: string): { baseUrl: string; normalizedPath: string } {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split('/').filter(Boolean).map(normalizeSegment);
    return { baseUrl: parsed.origin, normalizedPath: '/' + segments.join('/') };
  } catch {
    return { baseUrl: 'unknown', normalizedPath: url };
  }
}

// --- Service Detection ---

const SERVICE_PATTERNS: [RegExp, string][] = [
  [/\.supabase\.co$/, 'Supabase'],
  [/\.workers\.dev$/, 'Cloudflare Workers'],
  [/\.vercel\.app$/, 'Vercel'],
  [/api\.stripe\.com$/, 'Stripe'],
  [/\.railway\.app$/, 'Railway'],
  [/api\.github\.com$/, 'GitHub API'],
  [/api\.openai\.com$/, 'OpenAI'],
  [/api\.anthropic\.com$/, 'Anthropic'],
  [/\.firebase(io|app)\.com$/, 'Firebase'],
  [/\.amazonaws\.com$/, 'AWS'],
  [/\.googleapis\.com$/, 'Google APIs'],
  [/^(localhost|127\.0\.0\.1)$/, 'Your API'],
];

function detectService(hostname: string): string {
  for (const [pattern, name] of SERVICE_PATTERNS) {
    if (pattern.test(hostname)) return name;
  }
  const parts = hostname.split('.');
  return parts.length >= 2 ? parts.slice(-2).join('.') : hostname;
}

function detectAuth(headers: Record<string, string>): { type: 'bearer' | 'basic' | 'api_key' | 'cookie' | 'none'; headerName?: string } {
  const authHeader = headers['authorization'] || headers['Authorization'];
  if (authHeader) {
    if (authHeader.startsWith('Bearer ')) return { type: 'bearer', headerName: 'Authorization' };
    if (authHeader.startsWith('Basic ')) return { type: 'basic', headerName: 'Authorization' };
    return { type: 'api_key', headerName: 'Authorization' };
  }
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase().includes('api-key') || key.toLowerCase() === 'x-api-key') {
      return { type: 'api_key', headerName: key };
    }
  }
  if (headers['cookie'] || headers['Cookie']) return { type: 'cookie' };
  return { type: 'none' };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil(sorted.length * (p / 100)) - 1;
  return sorted[Math.max(0, idx)];
}

// --- Public API ---

interface EndpointData {
  normalizedPath: string;
  method: string;
  baseUrl: string;
  service: string;
  events: NetworkEvent[];
  auth: { type: 'bearer' | 'basic' | 'api_key' | 'cookie' | 'none'; headerName?: string };
  graphqlOperation?: { type: 'query' | 'mutation' | 'subscription'; name: string };
}

function buildEndpoints(network: NetworkEvent[]): Map<string, EndpointData> {
  const endpoints = new Map<string, EndpointData>();
  for (const event of network) {
    const { baseUrl, normalizedPath } = normalizeUrl(event.url);
    let hostname: string;
    try { hostname = new URL(event.url).hostname; } catch { hostname = 'unknown'; }
    const key = `${event.method.toUpperCase()} ${baseUrl}${normalizedPath}`;
    const existing = endpoints.get(key);
    if (existing) {
      existing.events.push(event);
    } else {
      endpoints.set(key, {
        normalizedPath,
        method: event.method.toUpperCase(),
        baseUrl,
        service: detectService(hostname),
        events: [event],
        auth: detectAuth(event.requestHeaders),
        graphqlOperation: event.graphqlOperation,
      });
    }
  }
  return endpoints;
}

export function computeEndpoints(network: NetworkEvent[]): ApiEndpoint[] {
  const endpoints = buildEndpoints(network);
  const results: ApiEndpoint[] = [];
  for (const ep of endpoints.values()) {
    const timestamps = ep.events.map((e) => e.timestamp);
    results.push({
      normalizedPath: ep.normalizedPath,
      method: ep.method,
      baseUrl: ep.baseUrl,
      service: ep.service,
      callCount: ep.events.length,
      firstSeen: Math.min(...timestamps),
      lastSeen: Math.max(...timestamps),
      auth: ep.auth,
      graphqlOperation: ep.graphqlOperation,
    });
  }
  return results.sort((a, b) => b.callCount - a.callCount);
}

export function computeEndpointHealth(network: NetworkEvent[]): ApiEndpointHealth[] {
  const endpoints = buildEndpoints(network);
  const results: ApiEndpointHealth[] = [];
  for (const ep of endpoints.values()) {
    const durations = ep.events.map((e) => e.duration).sort((a, b) => a - b);
    const errorCount = ep.events.filter((e) => e.status >= 400).length;
    const errorCodes: Record<number, number> = {};
    for (const e of ep.events) {
      if (e.status >= 400) errorCodes[e.status] = (errorCodes[e.status] ?? 0) + 1;
    }
    results.push({
      normalizedPath: ep.normalizedPath,
      method: ep.method,
      service: ep.service,
      callCount: ep.events.length,
      successRate: (ep.events.length - errorCount) / ep.events.length,
      avgLatency: durations.reduce((s, d) => s + d, 0) / durations.length,
      p50Latency: percentile(durations, 50),
      p95Latency: percentile(durations, 95),
      errorRate: errorCount / ep.events.length,
      errorCodes,
    });
  }
  return results.sort((a, b) => b.callCount - a.callCount);
}

export function computeServices(network: NetworkEvent[]): ServiceInfo[] {
  const endpoints = buildEndpoints(network);
  const services = new Map<string, {
    baseUrl: string;
    endpoints: Set<string>;
    totalCalls: number;
    totalDuration: number;
    errorCount: number;
    auth: { type: 'bearer' | 'basic' | 'api_key' | 'cookie' | 'none'; headerName?: string };
    platform?: string;
  }>();

  for (const ep of endpoints.values()) {
    const existing = services.get(ep.service);
    if (existing) {
      existing.endpoints.add(`${ep.method} ${ep.normalizedPath}`);
      existing.totalCalls += ep.events.length;
      existing.totalDuration += ep.events.reduce((s, e) => s + e.duration, 0);
      existing.errorCount += ep.events.filter((e) => e.status >= 400).length;
    } else {
      let platform: string | undefined;
      try {
        const hostname = new URL(ep.baseUrl).hostname;
        for (const [pattern, name] of SERVICE_PATTERNS) {
          if (pattern.test(hostname)) { platform = name; break; }
        }
      } catch { /* ignore */ }
      services.set(ep.service, {
        baseUrl: ep.baseUrl,
        endpoints: new Set([`${ep.method} ${ep.normalizedPath}`]),
        totalCalls: ep.events.length,
        totalDuration: ep.events.reduce((s, e) => s + e.duration, 0),
        errorCount: ep.events.filter((e) => e.status >= 400).length,
        auth: ep.auth,
        platform,
      });
    }
  }

  const results: ServiceInfo[] = [];
  for (const [name, data] of services) {
    results.push({
      name,
      baseUrl: data.baseUrl,
      endpointCount: data.endpoints.size,
      totalCalls: data.totalCalls,
      avgLatency: data.totalCalls > 0 ? data.totalDuration / data.totalCalls : 0,
      errorRate: data.totalCalls > 0 ? data.errorCount / data.totalCalls : 0,
      auth: data.auth,
      detectedPlatform: data.platform,
    });
  }
  return results.sort((a, b) => b.totalCalls - a.totalCalls);
}
