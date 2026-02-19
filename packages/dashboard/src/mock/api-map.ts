import type { ApiEndpoint, ApiEndpointHealth, ServiceInfo } from './types';

const BASE = Date.now() - 300_000;

export const MOCK_ENDPOINTS: ApiEndpoint[] = [
  { normalizedPath: '/api/campaigns', method: 'GET', baseUrl: 'https://api.example.com', service: 'campaigns-api', callCount: 24, firstSeen: BASE - 86400000, lastSeen: BASE + 60000, auth: { type: 'bearer', headerName: 'authorization' } },
  { normalizedPath: '/api/campaigns', method: 'POST', baseUrl: 'https://api.example.com', service: 'campaigns-api', callCount: 5, firstSeen: BASE - 86400000, lastSeen: BASE + 10000, auth: { type: 'bearer', headerName: 'authorization' } },
  { normalizedPath: '/api/campaigns/:id', method: 'PUT', baseUrl: 'https://api.example.com', service: 'campaigns-api', callCount: 3, firstSeen: BASE - 86400000, lastSeen: BASE + 55000, auth: { type: 'bearer', headerName: 'authorization' } },
  { normalizedPath: '/api/campaigns/:id', method: 'DELETE', baseUrl: 'https://api.example.com', service: 'campaigns-api', callCount: 2, firstSeen: BASE - 43200000, lastSeen: BASE + 8000, auth: { type: 'bearer', headerName: 'authorization' } },
  { normalizedPath: '/api/campaigns/:id/ads', method: 'GET', baseUrl: 'https://api.example.com', service: 'campaigns-api', callCount: 18, firstSeen: BASE - 86400000, lastSeen: BASE + 30000, auth: { type: 'bearer', headerName: 'authorization' } },
  { normalizedPath: '/api/campaigns/:id/stats', method: 'GET', baseUrl: 'https://api.example.com', service: 'campaigns-api', callCount: 8, firstSeen: BASE - 86400000, lastSeen: BASE + 40000, auth: { type: 'bearer', headerName: 'authorization' } },
  { normalizedPath: '/api/campaigns/search', method: 'POST', baseUrl: 'https://api.example.com', service: 'campaigns-api', callCount: 4, firstSeen: BASE - 43200000, lastSeen: BASE + 70000, auth: { type: 'bearer', headerName: 'authorization' } },
  { normalizedPath: '/api/users/me', method: 'GET', baseUrl: 'https://api.example.com', service: 'auth-api', callCount: 45, firstSeen: BASE - 86400000, lastSeen: BASE + 25000, auth: { type: 'bearer', headerName: 'authorization' } },
  { normalizedPath: '/api/auth/refresh', method: 'POST', baseUrl: 'https://api.example.com', service: 'auth-api', callCount: 6, firstSeen: BASE - 86400000, lastSeen: BASE + 45000, auth: { type: 'cookie' } },
  { normalizedPath: '/api/notifications', method: 'GET', baseUrl: 'https://api.example.com', service: 'notifications-api', callCount: 12, firstSeen: BASE - 86400000, lastSeen: BASE + 65000, auth: { type: 'bearer', headerName: 'authorization' } },
  { normalizedPath: '/api/upload', method: 'POST', baseUrl: 'https://api.example.com', service: 'media-api', callCount: 3, firstSeen: BASE - 43200000, lastSeen: BASE + 60000, auth: { type: 'bearer', headerName: 'authorization' } },
  { normalizedPath: '/graphql', method: 'POST', baseUrl: 'https://api.example.com', service: 'graphql-api', callCount: 15, firstSeen: BASE - 86400000, lastSeen: BASE + 35000, auth: { type: 'bearer', headerName: 'authorization' }, graphqlOperation: { type: 'query', name: 'GetCharacter' } },
  { normalizedPath: '/mp/collect', method: 'POST', baseUrl: 'https://mp.example.com', service: 'analytics', callCount: 32, firstSeen: BASE - 86400000, lastSeen: BASE + 20000, auth: { type: 'api_key' } },
  { normalizedPath: '/api/process', method: 'POST', baseUrl: 'https://api.example.com', service: 'campaigns-api', callCount: 2, firstSeen: BASE - 21600000, lastSeen: BASE + 15000, auth: { type: 'bearer', headerName: 'authorization' } },
  { normalizedPath: '/api/invalid', method: 'GET', baseUrl: 'https://api.example.com', service: 'campaigns-api', callCount: 1, firstSeen: BASE + 12000, lastSeen: BASE + 12000, auth: { type: 'none' } },
];

export const MOCK_ENDPOINT_HEALTH: ApiEndpointHealth[] = [
  { normalizedPath: '/api/campaigns', method: 'GET', service: 'campaigns-api', callCount: 24, successRate: 1.0, avgLatency: 85, p50Latency: 78, p95Latency: 145, errorRate: 0, errorCodes: {} },
  { normalizedPath: '/api/campaigns', method: 'POST', service: 'campaigns-api', callCount: 5, successRate: 1.0, avgLatency: 210, p50Latency: 195, p95Latency: 310, errorRate: 0, errorCodes: {} },
  { normalizedPath: '/api/campaigns/:id', method: 'PUT', service: 'campaigns-api', callCount: 3, successRate: 0.67, avgLatency: 34, p50Latency: 30, p95Latency: 42, errorRate: 0.33, errorCodes: { 422: 1 } },
  { normalizedPath: '/api/campaigns/:id/ads', method: 'GET', service: 'campaigns-api', callCount: 18, successRate: 1.0, avgLatency: 156, p50Latency: 142, p95Latency: 245, errorRate: 0, errorCodes: {} },
  { normalizedPath: '/api/process', method: 'POST', service: 'campaigns-api', callCount: 2, successRate: 0, avgLatency: 3200, p50Latency: 3200, p95Latency: 3200, errorRate: 1.0, errorCodes: { 500: 2 } },
  { normalizedPath: '/api/users/me', method: 'GET', service: 'auth-api', callCount: 45, successRate: 1.0, avgLatency: 45, p50Latency: 40, p95Latency: 85, errorRate: 0, errorCodes: {} },
  { normalizedPath: '/graphql', method: 'POST', service: 'graphql-api', callCount: 15, successRate: 1.0, avgLatency: 370, p50Latency: 340, p95Latency: 520, errorRate: 0, errorCodes: {} },
  { normalizedPath: '/api/campaigns/search', method: 'POST', service: 'campaigns-api', callCount: 4, successRate: 0.75, avgLatency: 7508, p50Latency: 250, p95Latency: 30000, errorRate: 0.25, errorCodes: { 408: 1 } },
];

export const MOCK_SERVICES: ServiceInfo[] = [
  { name: 'campaigns-api', baseUrl: 'https://api.example.com', endpointCount: 8, totalCalls: 87, avgLatency: 145, errorRate: 0.04, auth: { type: 'bearer', headerName: 'authorization' }, detectedPlatform: 'Vercel' },
  { name: 'auth-api', baseUrl: 'https://api.example.com', endpointCount: 2, totalCalls: 51, avgLatency: 112, errorRate: 0, auth: { type: 'bearer', headerName: 'authorization' }, detectedPlatform: 'Vercel' },
  { name: 'graphql-api', baseUrl: 'https://api.example.com', endpointCount: 1, totalCalls: 15, avgLatency: 370, errorRate: 0, auth: { type: 'bearer', headerName: 'authorization' } },
  { name: 'notifications-api', baseUrl: 'https://api.example.com', endpointCount: 1, totalCalls: 12, avgLatency: 110, errorRate: 0, auth: { type: 'bearer', headerName: 'authorization' } },
  { name: 'media-api', baseUrl: 'https://api.example.com', endpointCount: 1, totalCalls: 3, avgLatency: 2400, errorRate: 0, auth: { type: 'bearer', headerName: 'authorization' } },
  { name: 'analytics', baseUrl: 'https://mp.example.com', endpointCount: 1, totalCalls: 32, avgLatency: 1200, errorRate: 0, auth: { type: 'api_key' }, detectedPlatform: 'Mixpanel' },
];
