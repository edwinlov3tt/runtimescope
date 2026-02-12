import type { EventStore } from '../store.js';
import type {
  NetworkEvent,
  ApiEndpoint,
  ApiEndpointHealth,
  ApiContract,
  ApiContractField,
  ServiceInfo,
  ApiChangeRecord,
  AuthInfo,
  GraphQLOperation,
  DetectedIssue,
} from '../types.js';

// ============================================================
// API Discovery Engine
// Auto-discovers and catalogs every API endpoint from network traffic
// ============================================================

// --- URL Normalization ---

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMERIC_RE = /^\d+$/;
const MONGO_ID_RE = /^[0-9a-f]{24}$/i;
const SHORT_HASH_RE = /^[0-9a-f]{8,}$/i;
const LONG_ALPHANUM_RE = /^[a-zA-Z0-9_-]{20,}$/;
const BASE64_RE = /^[a-zA-Z0-9+/=_-]{16,}$/;

function normalizeSegment(segment: string): string {
  if (UUID_RE.test(segment)) return ':id';
  if (NUMERIC_RE.test(segment)) return ':id';
  if (MONGO_ID_RE.test(segment)) return ':id';
  if (SHORT_HASH_RE.test(segment) && segment.length >= 8) return ':id';
  if (LONG_ALPHANUM_RE.test(segment)) return ':id';
  if (BASE64_RE.test(segment) && segment.length >= 16) return ':token';
  return segment;
}

function normalizeUrl(url: string): { baseUrl: string; normalizedPath: string } {
  try {
    const parsed = new URL(url);
    const baseUrl = parsed.origin;
    const segments = parsed.pathname.split('/').filter(Boolean);
    const normalized = segments.map(normalizeSegment);
    return { baseUrl, normalizedPath: '/' + normalized.join('/') };
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
  [/\.netlify\.app$/, 'Netlify'],
  [/\.fly\.dev$/, 'Fly.io'],
  [/\.render\.com$/, 'Render'],
  [/api\.github\.com$/, 'GitHub API'],
  [/api\.openai\.com$/, 'OpenAI'],
  [/api\.anthropic\.com$/, 'Anthropic'],
  [/\.clerk\.dev$/, 'Clerk'],
  [/\.auth0\.com$/, 'Auth0'],
  [/\.firebase(io|app)\.com$/, 'Firebase'],
  [/\.amazonaws\.com$/, 'AWS'],
  [/\.googleapis\.com$/, 'Google APIs'],
  [/^(localhost|127\.0\.0\.1)$/, 'Your API'],
];

function detectService(hostname: string): string {
  for (const [pattern, name] of SERVICE_PATTERNS) {
    if (pattern.test(hostname)) return name;
  }
  // Derive from hostname: api.example.com → example.com
  const parts = hostname.split('.');
  if (parts.length >= 2) {
    return parts.slice(-2).join('.');
  }
  return hostname;
}

// --- Auth Detection ---

function detectAuth(headers: Record<string, string>): AuthInfo {
  const authHeader = headers['authorization'] || headers['Authorization'];
  if (authHeader) {
    if (authHeader.startsWith('Bearer ')) return { type: 'bearer', headerName: 'Authorization' };
    if (authHeader.startsWith('Basic ')) return { type: 'basic', headerName: 'Authorization' };
    return { type: 'api_key', headerName: 'Authorization' };
  }

  // Check for common API key headers
  for (const key of Object.keys(headers)) {
    const lower = key.toLowerCase();
    if (lower.includes('api-key') || lower.includes('apikey') || lower === 'x-api-key') {
      return { type: 'api_key', headerName: key };
    }
  }

  // Check for cookie-based auth
  if (headers['cookie'] || headers['Cookie']) {
    return { type: 'cookie' };
  }

  return { type: 'none' };
}

// --- Contract Inference ---

function inferFieldType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function walkObject(obj: unknown, prefix = ''): ApiContractField[] {
  const fields: ApiContractField[] = [];
  if (obj === null || obj === undefined || typeof obj !== 'object') return fields;

  if (Array.isArray(obj)) {
    fields.push({ path: prefix || '[]', type: 'array', nullable: false, example: `[${obj.length} items]` });
    if (obj.length > 0 && typeof obj[0] === 'object' && obj[0] !== null) {
      const itemFields = walkObject(obj[0], prefix ? `${prefix}[]` : '[]');
      fields.push(...itemFields);
    }
    return fields;
  }

  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    const type = inferFieldType(value);
    fields.push({
      path,
      type,
      nullable: value === null,
      example: typeof value === 'string' ? value.slice(0, 50) : value,
    });
    if (type === 'object' && value !== null) {
      fields.push(...walkObject(value, path));
    }
  }

  return fields;
}

function inferContract(events: NetworkEvent[]): ApiContract | undefined {
  // Sample up to 10 events for contract inference
  const samples = events.slice(-10);
  const responseBodies = samples
    .filter((e) => e.responseBody)
    .map((e) => {
      try {
        return JSON.parse(e.responseBody!);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  if (responseBodies.length === 0) return undefined;

  const allFields = new Map<string, { types: Set<string>; nullable: boolean; example?: unknown }>();

  for (const body of responseBodies) {
    const fields = walkObject(body);
    for (const field of fields) {
      const existing = allFields.get(field.path);
      if (existing) {
        existing.types.add(field.type);
        if (field.nullable) existing.nullable = true;
      } else {
        allFields.set(field.path, {
          types: new Set([field.type]),
          nullable: field.nullable,
          example: field.example,
        });
      }
    }
  }

  const responseFields: ApiContractField[] = [];
  for (const [path, info] of allFields) {
    responseFields.push({
      path,
      type: [...info.types].join(' | '),
      nullable: info.nullable,
      example: info.example,
    });
  }

  return { responseFields, sampleCount: responseBodies.length };
}

// --- Percentile Calculation ---

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil(sorted.length * (p / 100)) - 1;
  return sorted[Math.max(0, idx)];
}

// --- Endpoint Key ---

function endpointKey(method: string, normalizedPath: string, baseUrl: string): string {
  return `${method.toUpperCase()} ${baseUrl}${normalizedPath}`;
}

// ============================================================
// Engine
// ============================================================

interface EndpointData {
  normalizedPath: string;
  method: string;
  baseUrl: string;
  service: string;
  events: NetworkEvent[];
  auth: AuthInfo;
  graphqlOperation?: GraphQLOperation;
}

export class ApiDiscoveryEngine {
  private endpoints: Map<string, EndpointData> = new Map();
  private store: EventStore;

  constructor(store: EventStore) {
    this.store = store;
  }

  rebuild(): void {
    this.endpoints.clear();
    const events = this.store.getNetworkRequests();
    for (const event of events) {
      this.ingestEvent(event);
    }
  }

  private ingestEvent(event: NetworkEvent): void {
    const { baseUrl, normalizedPath } = normalizeUrl(event.url);
    let hostname: string;
    try {
      hostname = new URL(event.url).hostname;
    } catch {
      hostname = 'unknown';
    }

    const key = endpointKey(event.method, normalizedPath, baseUrl);
    const existing = this.endpoints.get(key);

    if (existing) {
      existing.events.push(event);
      return;
    }

    this.endpoints.set(key, {
      normalizedPath,
      method: event.method.toUpperCase(),
      baseUrl,
      service: detectService(hostname),
      events: [event],
      auth: detectAuth(event.requestHeaders),
      graphqlOperation: event.graphqlOperation,
    });
  }

  // --- Refinement pass: parameterize segments with high cardinality ---

  private refineEndpoints(): void {
    // Group endpoints by method + baseUrl + segment count
    const groups = new Map<string, EndpointData[]>();
    for (const ep of this.endpoints.values()) {
      const segments = ep.normalizedPath.split('/').filter(Boolean);
      const groupKey = `${ep.method}|${ep.baseUrl}|${segments.length}`;
      const group = groups.get(groupKey) ?? [];
      group.push(ep);
      groups.set(groupKey, group);
    }

    // For each group, find segment positions with >5 distinct values
    for (const group of groups.values()) {
      if (group.length <= 5) continue;
      const segmentSets: Map<string, number>[] = [];

      for (const ep of group) {
        const segments = ep.normalizedPath.split('/').filter(Boolean);
        for (let i = 0; i < segments.length; i++) {
          if (!segmentSets[i]) segmentSets[i] = new Map();
          segmentSets[i].set(segments[i], (segmentSets[i].get(segments[i]) ?? 0) + 1);
        }
      }

      for (let i = 0; i < segmentSets.length; i++) {
        if (segmentSets[i] && segmentSets[i].size > 5) {
          // This position has high cardinality — parameterize it
          for (const ep of group) {
            const segments = ep.normalizedPath.split('/').filter(Boolean);
            if (segments[i] && segments[i] !== ':id' && segments[i] !== ':token') {
              segments[i] = ':id';
              ep.normalizedPath = '/' + segments.join('/');
            }
          }
        }
      }
    }

    // Merge duplicates that may have been created by refinement
    const merged = new Map<string, EndpointData>();
    for (const ep of this.endpoints.values()) {
      const key = endpointKey(ep.method, ep.normalizedPath, ep.baseUrl);
      const existing = merged.get(key);
      if (existing) {
        existing.events.push(...ep.events);
      } else {
        merged.set(key, { ...ep });
      }
    }
    this.endpoints = merged;
  }

  // --- Public API ---

  getCatalog(filter?: { service?: string; minCalls?: number }): ApiEndpoint[] {
    this.rebuild();
    this.refineEndpoints();

    const results: ApiEndpoint[] = [];
    for (const ep of this.endpoints.values()) {
      if (filter?.service && ep.service !== filter.service) continue;
      if (filter?.minCalls && ep.events.length < filter.minCalls) continue;

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
        contract: inferContract(ep.events),
        graphqlOperation: ep.graphqlOperation,
      });
    }

    return results.sort((a, b) => b.callCount - a.callCount);
  }

  getHealth(filter?: { endpoint?: string; sinceSeconds?: number }): ApiEndpointHealth[] {
    this.rebuild();
    this.refineEndpoints();

    const since = filter?.sinceSeconds ? Date.now() - filter.sinceSeconds * 1000 : 0;
    const results: ApiEndpointHealth[] = [];

    for (const ep of this.endpoints.values()) {
      if (filter?.endpoint) {
        const key = `${ep.method} ${ep.normalizedPath}`;
        if (!key.includes(filter.endpoint)) continue;
      }

      const events = ep.events.filter((e) => e.timestamp >= since);
      if (events.length === 0) continue;

      const durations = events.map((e) => e.duration).sort((a, b) => a - b);
      const errorCount = events.filter((e) => e.status >= 400).length;
      const errorCodes: Record<number, number> = {};
      for (const e of events) {
        if (e.status >= 400) {
          errorCodes[e.status] = (errorCodes[e.status] ?? 0) + 1;
        }
      }

      results.push({
        normalizedPath: ep.normalizedPath,
        method: ep.method,
        service: ep.service,
        callCount: events.length,
        successRate: (events.length - errorCount) / events.length,
        avgLatency: durations.reduce((s, d) => s + d, 0) / durations.length,
        p50Latency: percentile(durations, 50),
        p95Latency: percentile(durations, 95),
        errorRate: errorCount / events.length,
        errorCodes,
      });
    }

    return results.sort((a, b) => b.callCount - a.callCount);
  }

  getDocumentation(filter?: { service?: string; format?: string }): string {
    const catalog = this.getCatalog(filter ? { service: filter.service } : undefined);
    const health = this.getHealth();
    const healthMap = new Map(health.map((h) => [`${h.method} ${h.normalizedPath}`, h]));

    const lines: string[] = ['# API Documentation (Auto-Generated from Traffic)', ''];

    // Group by service
    const byService = new Map<string, ApiEndpoint[]>();
    for (const ep of catalog) {
      const list = byService.get(ep.service) ?? [];
      list.push(ep);
      byService.set(ep.service, list);
    }

    for (const [service, endpoints] of byService) {
      lines.push(`## ${service}`, '');

      for (const ep of endpoints) {
        const h = healthMap.get(`${ep.method} ${ep.normalizedPath}`);
        lines.push(`### ${ep.method} ${ep.normalizedPath}`);
        lines.push(`- Base URL: ${ep.baseUrl}`);
        lines.push(`- Calls: ${ep.callCount}`);
        lines.push(`- Auth: ${ep.auth.type}${ep.auth.headerName ? ` (${ep.auth.headerName})` : ''}`);

        if (h) {
          lines.push(`- Avg Latency: ${h.avgLatency.toFixed(0)}ms`);
          lines.push(`- P95 Latency: ${h.p95Latency.toFixed(0)}ms`);
          lines.push(`- Error Rate: ${(h.errorRate * 100).toFixed(1)}%`);
        }

        if (ep.graphqlOperation) {
          lines.push(`- GraphQL: ${ep.graphqlOperation.type} ${ep.graphqlOperation.name}`);
        }

        if (ep.contract) {
          lines.push('- Response Shape:');
          for (const field of ep.contract.responseFields.slice(0, 20)) {
            lines.push(`  - \`${field.path}\`: ${field.type}${field.nullable ? ' (nullable)' : ''}`);
          }
          if (ep.contract.responseFields.length > 20) {
            lines.push(`  - ... and ${ep.contract.responseFields.length - 20} more fields`);
          }
        }

        lines.push('');
      }
    }

    return lines.join('\n');
  }

  getServiceMap(): ServiceInfo[] {
    this.rebuild();
    this.refineEndpoints();

    const services = new Map<string, {
      baseUrl: string;
      endpoints: Set<string>;
      totalCalls: number;
      totalDuration: number;
      errorCount: number;
      auth: AuthInfo;
      platform?: string;
    }>();

    for (const ep of this.endpoints.values()) {
      const existing = services.get(ep.service);
      if (existing) {
        existing.endpoints.add(`${ep.method} ${ep.normalizedPath}`);
        existing.totalCalls += ep.events.length;
        existing.totalDuration += ep.events.reduce((s, e) => s + e.duration, 0);
        existing.errorCount += ep.events.filter((e) => e.status >= 400).length;
      } else {
        let detectedPlatform: string | undefined;
        try {
          const hostname = new URL(ep.baseUrl).hostname;
          for (const [pattern, name] of SERVICE_PATTERNS) {
            if (pattern.test(hostname)) {
              detectedPlatform = name;
              break;
            }
          }
        } catch { /* ignore */ }

        services.set(ep.service, {
          baseUrl: ep.baseUrl,
          endpoints: new Set([`${ep.method} ${ep.normalizedPath}`]),
          totalCalls: ep.events.length,
          totalDuration: ep.events.reduce((s, e) => s + e.duration, 0),
          errorCount: ep.events.filter((e) => e.status >= 400).length,
          auth: ep.auth,
          platform: detectedPlatform,
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

  getApiChanges(sessionA: string, sessionB: string): ApiChangeRecord[] {
    const allEvents = this.store.getNetworkRequests();

    const eventsA = allEvents.filter((e) => e.sessionId === sessionA);
    const eventsB = allEvents.filter((e) => e.sessionId === sessionB);

    const catalogA = this.buildCatalogFromEvents(eventsA);
    const catalogB = this.buildCatalogFromEvents(eventsB);

    const changes: ApiChangeRecord[] = [];
    const allKeys = new Set([...catalogA.keys(), ...catalogB.keys()]);

    for (const key of allKeys) {
      const a = catalogA.get(key);
      const b = catalogB.get(key);

      if (!a && b) {
        changes.push({
          normalizedPath: b.normalizedPath,
          method: b.method,
          changeType: 'added',
        });
      } else if (a && !b) {
        changes.push({
          normalizedPath: a.normalizedPath,
          method: a.method,
          changeType: 'removed',
        });
      } else if (a && b) {
        // Compare response shapes
        const contractA = inferContract(a.events);
        const contractB = inferContract(b.events);
        if (contractA && contractB) {
          const fieldsA = new Map(contractA.responseFields.map((f) => [f.path, f.type]));
          const fieldsB = new Map(contractB.responseFields.map((f) => [f.path, f.type]));
          const fieldChanges: ApiChangeRecord['fieldChanges'] = [];

          for (const [path, type] of fieldsB) {
            if (!fieldsA.has(path)) {
              fieldChanges.push({ path, change: 'added', newType: type });
            } else if (fieldsA.get(path) !== type) {
              fieldChanges.push({ path, change: 'type_changed', oldType: fieldsA.get(path), newType: type });
            }
          }
          for (const [path] of fieldsA) {
            if (!fieldsB.has(path)) {
              fieldChanges.push({ path, change: 'removed', oldType: fieldsA.get(path) });
            }
          }

          if (fieldChanges.length > 0) {
            changes.push({
              normalizedPath: a.normalizedPath,
              method: a.method,
              changeType: 'modified',
              fieldChanges,
            });
          }
        }
      }
    }

    return changes;
  }

  private buildCatalogFromEvents(events: NetworkEvent[]): Map<string, EndpointData> {
    const catalog = new Map<string, EndpointData>();
    for (const event of events) {
      const { baseUrl, normalizedPath } = normalizeUrl(event.url);
      let hostname: string;
      try {
        hostname = new URL(event.url).hostname;
      } catch {
        hostname = 'unknown';
      }
      const key = endpointKey(event.method, normalizedPath, baseUrl);
      const existing = catalog.get(key);
      if (existing) {
        existing.events.push(event);
      } else {
        catalog.set(key, {
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
    return catalog;
  }

  detectIssues(): DetectedIssue[] {
    const issues: DetectedIssue[] = [];
    const health = this.getHealth();

    for (const ep of health) {
      // API degradation: >50% error rate
      if (ep.errorRate > 0.5 && ep.callCount >= 3) {
        issues.push({
          id: `api-degradation-${ep.method}-${ep.normalizedPath}`,
          pattern: 'api_degradation',
          severity: 'medium',
          title: `API Degradation: ${ep.method} ${ep.normalizedPath}`,
          description: `Error rate is ${(ep.errorRate * 100).toFixed(0)}% (${Object.entries(ep.errorCodes).map(([k, v]) => `${k}: ${v}`).join(', ')})`,
          evidence: [`${ep.callCount} calls, ${(ep.errorRate * 100).toFixed(0)}% errors`],
          suggestion: 'Check server logs for this endpoint. Verify the backend is healthy.',
        });
      }

      // High latency: p95 > 5s
      if (ep.p95Latency > 5000 && ep.callCount >= 3) {
        issues.push({
          id: `high-latency-${ep.method}-${ep.normalizedPath}`,
          pattern: 'high_latency_endpoint',
          severity: 'medium',
          title: `High Latency: ${ep.method} ${ep.normalizedPath}`,
          description: `P95 latency is ${(ep.p95Latency / 1000).toFixed(1)}s`,
          evidence: [`p50: ${ep.p50Latency.toFixed(0)}ms, p95: ${ep.p95Latency.toFixed(0)}ms, avg: ${ep.avgLatency.toFixed(0)}ms`],
          suggestion: 'Consider adding caching, optimizing the query, or paginating the response.',
        });
      }
    }

    // Auth inconsistency: same service with mixed auth patterns
    const services = this.getServiceMap();
    const catalog = this.getCatalog();
    for (const service of services) {
      const serviceEndpoints = catalog.filter((ep) => ep.service === service.name);
      const authTypes = new Set(serviceEndpoints.map((ep) => ep.auth.type));
      if (authTypes.size > 1 && !authTypes.has('none')) {
        issues.push({
          id: `auth-inconsistency-${service.name}`,
          pattern: 'auth_inconsistency',
          severity: 'medium',
          title: `Auth Inconsistency: ${service.name}`,
          description: `Mixed auth patterns detected: ${[...authTypes].join(', ')}`,
          evidence: serviceEndpoints.map((ep) => `${ep.method} ${ep.normalizedPath}: ${ep.auth.type}`),
          suggestion: 'Verify that all endpoints for this service use consistent authentication.',
        });
      }
    }

    return issues;
  }
}
