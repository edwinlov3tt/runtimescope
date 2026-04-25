// ============================================================
// Project Management Types
// Shared between collector backend and dashboard frontend
// ============================================================

// --- Workspaces (multi-tenant containers) ---

/**
 * A workspace is the top-level tenancy boundary. Every project belongs to
 * exactly one workspace, and every API key is scoped to one workspace.
 * On single-user installs a "personal" workspace is auto-created and is
 * invisible to users until they create a second one.
 */
export interface PmWorkspace {
  id: string;             // ws_abc123
  name: string;           // "Personal", "Acme Team"
  slug: string;           // url-safe, unique — "personal", "acme"
  description?: string;
  createdAt: number;
  updatedAt: number;
  isDefault?: boolean;    // true for the auto-created "personal" workspace
}

/**
 * Workspace-scoped API key. SDKs authenticate with a key, the collector
 * looks up its workspace, and only projects in that workspace can accept
 * events from that key.
 */
export interface PmApiKey {
  /**
   * Raw secret. Populated ONLY by `createApiKey()`'s return value — the caller
   * must store it on the spot. Every subsequent read (list/get) returns this
   * field as an empty string; the server stores a SHA-256 hash, not the
   * plaintext, so there is no way to recover it later.
   */
  key: string;
  /** User-visible identifier — first ~11 chars of the raw token, e.g. "tk_9f2a1c3b". Safe to log. */
  keyPrefix: string;
  /** Last 4 chars of the raw token — for visual confirmation ("...a4f1"). */
  keyLast4: string;
  workspaceId: string;
  label: string;
  createdAt: number;
  lastUsedAt?: number;
  expiresAt?: number;
  revokedAt?: number;
}

// --- Projects ---

export type ProjectPhase = 'preliminary' | 'application_development' | 'post_implementation';
export type ProjectStatus = 'active' | 'suspended' | 'abandoned';

export interface PmProject {
  id: string;
  workspaceId?: string;    // references PmWorkspace.id; auto-populated on migration
  name: string;
  path?: string;
  claudeProjectKey?: string;
  runtimescopeProject?: string;
  runtimeProjectId?: string;
  runtimeApps?: string[];
  phase: ProjectPhase;
  managementAuthorized: boolean;
  probableToComplete: boolean;
  projectStatus: ProjectStatus;
  category?: string;
  sdkInstalled?: boolean;
  createdAt: number;
  updatedAt: number;
  metadata?: Record<string, unknown>;
}

// --- Tasks ---

export type TaskStatus = 'todo' | 'in_progress' | 'done';
export type TaskPriority = 'low' | 'medium' | 'high' | 'urgent';
export type TaskSource = 'manual' | 'claude_session' | 'github_issue';

export interface PmTask {
  id: string;
  projectId?: string;
  title: string;
  description?: string;
  status: TaskStatus;
  priority: TaskPriority;
  labels: string[];
  source: TaskSource;
  sourceRef?: string;
  sortOrder: number;
  assignedTo?: string;
  dueDate?: string;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}

// --- Sessions ---

export interface PmSession {
  id: string;
  projectId: string;
  jsonlPath: string;
  jsonlSize?: number;
  firstPrompt?: string;
  summary?: string;
  slug?: string;
  model?: string;
  version?: string;
  gitBranch?: string;
  messageCount: number;
  userMessageCount: number;
  assistantMessageCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheCreationTokens: number;
  totalCacheReadTokens: number;
  costMicrodollars: number;
  startedAt: number;
  endedAt?: number;
  activeMinutes: number;
  compactionCount: number;
  preCompactionTokens?: number;
  permissionMode?: string;
  createdAt: number;
  updatedAt: number;
}

export interface SessionStats {
  totalSessions: number;
  totalActiveMinutes: number;
  totalCostMicrodollars: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  avgSessionMinutes: number;
  modelBreakdown: { model: string; sessions: number; cost: number }[];
}

// --- Notes ---

export interface PmNote {
  id: string;
  projectId?: string;
  sessionId?: string;
  title: string;
  content: string;
  pinned: boolean;
  tags: string[];
  createdAt: number;
  updatedAt: number;
}

// --- CapEx ---

export type CapexClassification = 'capitalizable' | 'expensed';
export type WorkType = 'coding' | 'testing' | 'design' | 'planning' | 'maintenance' | 'bug_fix';

export interface PmCapexEntry {
  id: string;
  projectId: string;
  sessionId: string;
  classification: CapexClassification;
  workType?: WorkType;
  activeMinutes: number;
  costMicrodollars: number;
  adjustmentFactor: number;
  adjustedCostMicrodollars: number;
  confirmed: boolean;
  confirmedAt?: number;
  confirmedBy?: string;
  notes?: string;
  period: string; // YYYY-MM
  createdAt: number;
  updatedAt: number;
}

export interface CapexSummary {
  projectId: string;
  period?: { start: string; end: string };
  totalSessions: number;
  totalActiveMinutes: number;
  totalCostMicrodollars: number;
  capitalizableCostMicrodollars: number;
  expensedCostMicrodollars: number;
  confirmedCount: number;
  unconfirmedCount: number;
  byMonth: {
    period: string;
    capitalizable: number;
    expensed: number;
    activeMinutes: number;
  }[];
}

// --- Git ---

export type GitFileStatus = 'M' | 'A' | 'D' | 'R' | '?' | 'C' | 'U';

export interface GitFileChange {
  path: string;
  status: GitFileStatus;
  oldPath?: string;
}

export interface GitStatus {
  branch: string;
  staged: GitFileChange[];
  unstaged: GitFileChange[];
  untracked: GitFileChange[];
  isGitRepo: boolean;
}

export interface GitCommit {
  hash: string;
  shortHash: string;
  subject: string;
  message: string;
  author: string;
  relativeDate: string;
  refs: string;
}

// --- Memory & Rules ---

export interface MemoryFile {
  filename: string;
  content: string;
  sizeBytes: number;
}

export interface RulesFiles {
  global: { path: string; content: string; exists: boolean };
  project: { path: string; content: string; exists: boolean };
  local: { path: string; content: string; exists: boolean };
}
