// Types mirroring collector's types for the server SDK

export type DatabaseOperation = 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE' | 'OTHER';

export type DatabaseSource =
  | 'prisma'
  | 'drizzle'
  | 'knex'
  | 'pg'
  | 'mysql2'
  | 'better-sqlite3'
  | 'generic';

export interface DatabaseEvent {
  eventId: string;
  sessionId: string;
  timestamp: number;
  eventType: 'database';
  query: string;
  normalizedQuery: string;
  duration: number;
  rowsReturned?: number;
  rowsAffected?: number;
  tablesAccessed: string[];
  operation: DatabaseOperation;
  source: DatabaseSource;
  stackTrace?: string;
  label?: string;
  error?: string;
  params?: string;
}

export interface ServerSdkConfig {
  serverUrl?: string;
  appName?: string;
  sessionId?: string;
  captureStackTraces?: boolean;
  redactParams?: boolean;
  maxQueryLength?: number;
}

export interface WSMessage {
  type: 'event' | 'handshake' | 'heartbeat';
  payload: unknown;
  timestamp: number;
  sessionId: string;
}
