import type { DatabaseEvent, NormalizedQueryStats, SchemaTable } from './types';

const SESSION = 'sess_mock_001';
const BASE = Date.now() - 300_000;

export const MOCK_DATABASE: DatabaseEvent[] = [
  {
    eventId: 'db_001', sessionId: SESSION, timestamp: BASE + 1000, eventType: 'database',
    query: 'SELECT c.id, c.name, c.status, c.budget FROM campaigns c WHERE c.user_id = $1 ORDER BY c.created_at DESC LIMIT 50',
    normalizedQuery: 'SELECT ... FROM campaigns WHERE user_id = ? ORDER BY created_at DESC LIMIT ?',
    duration: 12, rowsReturned: 15, tablesAccessed: ['campaigns'], operation: 'SELECT', source: 'prisma',
  },
  {
    eventId: 'db_002', sessionId: SESSION, timestamp: BASE + 3000, eventType: 'database',
    query: "INSERT INTO campaigns (name, budget, status, user_id) VALUES ('New Campaign', 5000, 'draft', 1)",
    normalizedQuery: 'INSERT INTO campaigns (name, budget, status, user_id) VALUES (?, ?, ?, ?)',
    duration: 8, rowsAffected: 1, tablesAccessed: ['campaigns'], operation: 'INSERT', source: 'prisma',
  },
  {
    eventId: 'db_003', sessionId: SESSION, timestamp: BASE + 5000, eventType: 'database',
    query: 'SELECT a.id, a.title, a.status, a.campaign_id, a.impressions, a.clicks FROM ads a WHERE a.campaign_id = $1',
    normalizedQuery: 'SELECT ... FROM ads WHERE campaign_id = ?',
    duration: 24, rowsReturned: 8, tablesAccessed: ['ads'], operation: 'SELECT', source: 'prisma',
  },
  {
    eventId: 'db_004', sessionId: SESSION, timestamp: BASE + 8000, eventType: 'database',
    query: 'SELECT u.id, u.name, u.email, u.role FROM users u WHERE u.id = $1',
    normalizedQuery: 'SELECT ... FROM users WHERE id = ?',
    duration: 3, rowsReturned: 1, tablesAccessed: ['users'], operation: 'SELECT', source: 'prisma',
  },
  {
    eventId: 'db_005', sessionId: SESSION, timestamp: BASE + 12000, eventType: 'database',
    query: 'SELECT c.id, c.name, COUNT(a.id) as ad_count, SUM(a.impressions) as total_impressions FROM campaigns c LEFT JOIN ads a ON a.campaign_id = c.id WHERE c.user_id = $1 GROUP BY c.id ORDER BY total_impressions DESC',
    normalizedQuery: 'SELECT ... FROM campaigns LEFT JOIN ads ON ... WHERE user_id = ? GROUP BY ... ORDER BY ...',
    duration: 145, rowsReturned: 15, tablesAccessed: ['campaigns', 'ads'], operation: 'SELECT', source: 'prisma',
    label: 'getCampaignStats',
  },
  {
    eventId: 'db_006', sessionId: SESSION, timestamp: BASE + 15000, eventType: 'database',
    query: 'DELETE FROM campaigns WHERE id = $1 AND user_id = $2',
    normalizedQuery: 'DELETE FROM campaigns WHERE id = ? AND user_id = ?',
    duration: 6, rowsAffected: 1, tablesAccessed: ['campaigns'], operation: 'DELETE', source: 'prisma',
  },
  {
    eventId: 'db_007', sessionId: SESSION, timestamp: BASE + 18000, eventType: 'database',
    query: "UPDATE campaigns SET budget = -500, updated_at = NOW() WHERE id = $1",
    normalizedQuery: 'UPDATE campaigns SET budget = ?, updated_at = ? WHERE id = ?',
    duration: 4, rowsAffected: 0, tablesAccessed: ['campaigns'], operation: 'UPDATE', source: 'prisma',
    error: 'Check constraint violation: budget must be >= 0',
  },
  {
    eventId: 'db_008', sessionId: SESSION, timestamp: BASE + 22000, eventType: 'database',
    query: 'SELECT n.id, n.title, n.type, n.read, n.created_at FROM notifications n WHERE n.user_id = $1 AND n.read = false ORDER BY n.created_at DESC LIMIT 20',
    normalizedQuery: 'SELECT ... FROM notifications WHERE user_id = ? AND read = ? ORDER BY created_at DESC LIMIT ?',
    duration: 18, rowsReturned: 7, tablesAccessed: ['notifications'], operation: 'SELECT', source: 'prisma',
  },
  {
    eventId: 'db_009', sessionId: SESSION, timestamp: BASE + 25000, eventType: 'database',
    query: 'SELECT s.date, s.impressions, s.clicks, s.spend FROM campaign_stats s WHERE s.campaign_id = $1 AND s.date >= $2 ORDER BY s.date',
    normalizedQuery: 'SELECT ... FROM campaign_stats WHERE campaign_id = ? AND date >= ? ORDER BY date',
    duration: 35, rowsReturned: 30, tablesAccessed: ['campaign_stats'], operation: 'SELECT', source: 'prisma',
  },
  {
    eventId: 'db_010', sessionId: SESSION, timestamp: BASE + 28000, eventType: 'database',
    query: 'SELECT COUNT(*) as total, SUM(CASE WHEN status = \'error\' THEN 1 ELSE 0 END) as errors FROM deploy_logs WHERE project = $1',
    normalizedQuery: 'SELECT COUNT(*), SUM(...) FROM deploy_logs WHERE project = ?',
    duration: 22, rowsReturned: 1, tablesAccessed: ['deploy_logs'], operation: 'SELECT', source: 'pg',
  },
  {
    eventId: 'db_011', sessionId: SESSION, timestamp: BASE + 32000, eventType: 'database',
    query: 'SELECT * FROM campaigns c WHERE c.name ILIKE $1 OR c.description ILIKE $1 ORDER BY c.updated_at DESC',
    normalizedQuery: 'SELECT * FROM campaigns WHERE name ILIKE ? OR description ILIKE ? ORDER BY updated_at DESC',
    duration: 89, rowsReturned: 3, tablesAccessed: ['campaigns'], operation: 'SELECT', source: 'prisma',
    label: 'searchCampaigns',
  },
];

export const MOCK_QUERY_STATS: NormalizedQueryStats[] = [
  { normalizedQuery: 'SELECT ... FROM campaigns WHERE user_id = ? ORDER BY created_at DESC LIMIT ?', tables: ['campaigns'], operation: 'SELECT', callCount: 24, avgDuration: 14, maxDuration: 45, p95Duration: 32, totalDuration: 336, avgRowsReturned: 12 },
  { normalizedQuery: 'SELECT ... FROM ads WHERE campaign_id = ?', tables: ['ads'], operation: 'SELECT', callCount: 18, avgDuration: 22, maxDuration: 68, p95Duration: 55, totalDuration: 396, avgRowsReturned: 6 },
  { normalizedQuery: 'SELECT ... FROM users WHERE id = ?', tables: ['users'], operation: 'SELECT', callCount: 45, avgDuration: 3, maxDuration: 12, p95Duration: 8, totalDuration: 135, avgRowsReturned: 1 },
  { normalizedQuery: 'SELECT ... FROM campaigns LEFT JOIN ads ON ... WHERE user_id = ? GROUP BY ...', tables: ['campaigns', 'ads'], operation: 'SELECT', callCount: 8, avgDuration: 135, maxDuration: 280, p95Duration: 245, totalDuration: 1080, avgRowsReturned: 15 },
  { normalizedQuery: 'INSERT INTO campaigns ...', tables: ['campaigns'], operation: 'INSERT', callCount: 5, avgDuration: 8, maxDuration: 15, p95Duration: 14, totalDuration: 40, avgRowsReturned: 0 },
  { normalizedQuery: 'SELECT ... FROM notifications WHERE user_id = ? AND read = ?', tables: ['notifications'], operation: 'SELECT', callCount: 12, avgDuration: 16, maxDuration: 42, p95Duration: 35, totalDuration: 192, avgRowsReturned: 5 },
];

export const MOCK_SCHEMA: SchemaTable[] = [
  {
    name: 'campaigns',
    columns: [
      { name: 'id', type: 'serial', nullable: false, isPrimaryKey: true },
      { name: 'name', type: 'varchar(255)', nullable: false, isPrimaryKey: false },
      { name: 'status', type: 'varchar(50)', nullable: false, defaultValue: "'draft'", isPrimaryKey: false },
      { name: 'budget', type: 'decimal(10,2)', nullable: true, isPrimaryKey: false },
      { name: 'user_id', type: 'integer', nullable: false, isPrimaryKey: false },
      { name: 'created_at', type: 'timestamptz', nullable: false, defaultValue: 'now()', isPrimaryKey: false },
      { name: 'updated_at', type: 'timestamptz', nullable: false, defaultValue: 'now()', isPrimaryKey: false },
    ],
    foreignKeys: [{ column: 'user_id', referencedTable: 'users', referencedColumn: 'id' }],
    indexes: [
      { name: 'campaigns_pkey', columns: ['id'], unique: true },
      { name: 'campaigns_user_id_idx', columns: ['user_id'], unique: false },
      { name: 'campaigns_status_idx', columns: ['status'], unique: false },
    ],
    rowCount: 247,
  },
  {
    name: 'ads',
    columns: [
      { name: 'id', type: 'serial', nullable: false, isPrimaryKey: true },
      { name: 'title', type: 'varchar(255)', nullable: false, isPrimaryKey: false },
      { name: 'status', type: 'varchar(50)', nullable: false, defaultValue: "'pending'", isPrimaryKey: false },
      { name: 'campaign_id', type: 'integer', nullable: false, isPrimaryKey: false },
      { name: 'impressions', type: 'integer', nullable: false, defaultValue: '0', isPrimaryKey: false },
      { name: 'clicks', type: 'integer', nullable: false, defaultValue: '0', isPrimaryKey: false },
      { name: 'created_at', type: 'timestamptz', nullable: false, defaultValue: 'now()', isPrimaryKey: false },
    ],
    foreignKeys: [{ column: 'campaign_id', referencedTable: 'campaigns', referencedColumn: 'id' }],
    indexes: [
      { name: 'ads_pkey', columns: ['id'], unique: true },
      { name: 'ads_campaign_id_idx', columns: ['campaign_id'], unique: false },
    ],
    rowCount: 1842,
  },
  {
    name: 'users',
    columns: [
      { name: 'id', type: 'serial', nullable: false, isPrimaryKey: true },
      { name: 'name', type: 'varchar(255)', nullable: false, isPrimaryKey: false },
      { name: 'email', type: 'varchar(255)', nullable: false, isPrimaryKey: false },
      { name: 'role', type: 'varchar(50)', nullable: false, defaultValue: "'user'", isPrimaryKey: false },
      { name: 'created_at', type: 'timestamptz', nullable: false, defaultValue: 'now()', isPrimaryKey: false },
    ],
    foreignKeys: [],
    indexes: [
      { name: 'users_pkey', columns: ['id'], unique: true },
      { name: 'users_email_key', columns: ['email'], unique: true },
    ],
    rowCount: 89,
  },
  {
    name: 'notifications',
    columns: [
      { name: 'id', type: 'serial', nullable: false, isPrimaryKey: true },
      { name: 'title', type: 'varchar(255)', nullable: false, isPrimaryKey: false },
      { name: 'type', type: 'varchar(50)', nullable: false, isPrimaryKey: false },
      { name: 'read', type: 'boolean', nullable: false, defaultValue: 'false', isPrimaryKey: false },
      { name: 'user_id', type: 'integer', nullable: false, isPrimaryKey: false },
      { name: 'created_at', type: 'timestamptz', nullable: false, defaultValue: 'now()', isPrimaryKey: false },
    ],
    foreignKeys: [{ column: 'user_id', referencedTable: 'users', referencedColumn: 'id' }],
    indexes: [
      { name: 'notifications_pkey', columns: ['id'], unique: true },
      { name: 'notifications_user_read_idx', columns: ['user_id', 'read'], unique: false },
    ],
    rowCount: 456,
  },
  {
    name: 'campaign_stats',
    columns: [
      { name: 'id', type: 'serial', nullable: false, isPrimaryKey: true },
      { name: 'campaign_id', type: 'integer', nullable: false, isPrimaryKey: false },
      { name: 'date', type: 'date', nullable: false, isPrimaryKey: false },
      { name: 'impressions', type: 'integer', nullable: false, defaultValue: '0', isPrimaryKey: false },
      { name: 'clicks', type: 'integer', nullable: false, defaultValue: '0', isPrimaryKey: false },
      { name: 'spend', type: 'decimal(10,2)', nullable: false, defaultValue: '0', isPrimaryKey: false },
    ],
    foreignKeys: [{ column: 'campaign_id', referencedTable: 'campaigns', referencedColumn: 'id' }],
    indexes: [
      { name: 'campaign_stats_pkey', columns: ['id'], unique: true },
      { name: 'campaign_stats_campaign_date_idx', columns: ['campaign_id', 'date'], unique: true },
    ],
    rowCount: 7350,
  },
];
