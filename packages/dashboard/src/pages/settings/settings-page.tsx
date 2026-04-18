/**
 * Settings page — workspace management + API key administration.
 * For now this page is single-purpose (workspaces); future settings
 * subsections will live alongside.
 */

import { useState, useEffect, useCallback } from 'react';
import {
  Plus,
  Trash2,
  Key,
  Copy,
  Check,
  AlertTriangle,
  ChevronRight,
  Users,
} from 'lucide-react';
import { cn } from '@/lib/cn';
import { useWorkspaceStore } from '@/stores/use-workspace-store';
import type { PmWorkspace } from '@/lib/pm-types';

const PANEL = 'bg-bg-elevated border border-border-default rounded-lg';
const BTN = 'h-8 px-3 rounded-md text-[12px] font-medium transition-colors cursor-pointer inline-flex items-center gap-1.5';
const BTN_PRIMARY = `${BTN} bg-accent text-white hover:bg-accent/90`;
const BTN_GHOST = `${BTN} text-text-secondary hover:text-text-primary hover:bg-bg-hover`;
const BTN_DANGER = `${BTN} text-red hover:bg-red/10`;

export function SettingsPage() {
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const loading = useWorkspaceStore((s) => s.workspacesLoading);
  const fetchWorkspaces = useWorkspaceStore((s) => s.fetchWorkspaces);

  useEffect(() => {
    fetchWorkspaces();
  }, [fetchWorkspaces]);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = workspaces.find((w) => w.id === selectedId) ?? null;

  // Auto-select the first workspace on first load
  useEffect(() => {
    if (!selectedId && workspaces.length > 0) {
      setSelectedId(workspaces[0].id);
    }
  }, [workspaces, selectedId]);

  return (
    <div className="flex-1 flex overflow-hidden">
      {/* Sidebar — list of workspaces */}
      <div className="w-[300px] border-r border-border-muted flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border-muted">
          <h2 className="text-[13px] font-semibold uppercase tracking-wider text-text-muted">
            Workspaces
          </h2>
          <CreateWorkspaceButton />
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          {loading && workspaces.length === 0 && (
            <div className="text-[12px] text-text-muted px-3 py-4">Loading…</div>
          )}
          {workspaces.map((ws) => (
            <button
              key={ws.id}
              onClick={() => setSelectedId(ws.id)}
              className={cn(
                'w-full flex items-center justify-between gap-2 px-3 py-2 rounded-md text-[13px] text-left cursor-pointer transition-colors',
                selectedId === ws.id
                  ? 'bg-accent-muted text-text-primary'
                  : 'hover:bg-bg-hover text-text-secondary',
              )}
            >
              <div className="flex items-center gap-2 truncate">
                <Users size={14} className="shrink-0" />
                <span className="truncate">{ws.name}</span>
                {ws.isDefault && (
                  <span className="text-[10px] text-text-muted uppercase tracking-wide">default</span>
                )}
              </div>
              <ChevronRight size={14} className="text-text-muted shrink-0" />
            </button>
          ))}
        </div>
      </div>

      {/* Detail pane */}
      <div className="flex-1 overflow-y-auto p-6">
        {selected ? (
          <WorkspaceDetail workspace={selected} />
        ) : (
          <div className="text-[13px] text-text-muted">Select a workspace</div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Create Workspace Button
// ---------------------------------------------------------------------------

function CreateWorkspaceButton() {
  const createWorkspace = useWorkspaceStore((s) => s.createWorkspace);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');

  const handleCreate = async () => {
    if (!name.trim()) return;
    const ws = await createWorkspace({ name: name.trim(), description: description.trim() || undefined });
    if (ws) {
      setName('');
      setDescription('');
      setOpen(false);
    }
  };

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className={BTN_PRIMARY}>
        <Plus size={12} />
        New
      </button>
    );
  }

  return (
    <div className="absolute top-14 left-2 right-2 z-20 bg-bg-surface border border-border-strong rounded-lg p-3 shadow-lg space-y-2">
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') handleCreate();
          if (e.key === 'Escape') setOpen(false);
        }}
        placeholder="Workspace name"
        className="w-full h-8 bg-bg-input border border-border-strong rounded-md px-2 text-[12px] outline-none focus:border-accent-border"
      />
      <input
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="Description (optional)"
        className="w-full h-8 bg-bg-input border border-border-strong rounded-md px-2 text-[12px] outline-none focus:border-accent-border"
      />
      <div className="flex gap-2 justify-end">
        <button onClick={() => setOpen(false)} className={BTN_GHOST}>Cancel</button>
        <button onClick={handleCreate} className={BTN_PRIMARY}>Create</button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Workspace Detail (name + API keys)
// ---------------------------------------------------------------------------

function WorkspaceDetail({ workspace }: { workspace: PmWorkspace }) {
  const deleteWorkspace = useWorkspaceStore((s) => s.deleteWorkspace);
  const updateWorkspace = useWorkspaceStore((s) => s.updateWorkspace);

  return (
    <div className="max-w-3xl space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-text-primary">{workspace.name}</h1>
          {workspace.description && (
            <p className="text-[13px] text-text-muted mt-0.5">{workspace.description}</p>
          )}
          <p className="text-[11px] text-text-muted font-mono mt-1">
            {workspace.id} · slug: {workspace.slug}
          </p>
        </div>
        {!workspace.isDefault && (
          <button
            onClick={() => {
              if (confirm(`Delete workspace "${workspace.name}"? Its projects will be moved to the default workspace.`)) {
                deleteWorkspace(workspace.id);
              }
            }}
            className={BTN_DANGER}
          >
            <Trash2 size={12} />
            Delete
          </button>
        )}
      </div>

      {/* Edit name/description */}
      <WorkspaceEditForm workspace={workspace} onSave={(updates) => updateWorkspace(workspace.id, updates)} />

      {/* API keys */}
      <ApiKeysPanel workspaceId={workspace.id} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Workspace edit form
// ---------------------------------------------------------------------------

function WorkspaceEditForm({
  workspace,
  onSave,
}: {
  workspace: PmWorkspace;
  onSave: (updates: { name?: string; description?: string }) => Promise<void> | void;
}) {
  const [name, setName] = useState(workspace.name);
  const [description, setDescription] = useState(workspace.description ?? '');
  const isDirty = name !== workspace.name || (description || undefined) !== workspace.description;

  // Reset form when a different workspace is selected
  useEffect(() => {
    setName(workspace.name);
    setDescription(workspace.description ?? '');
  }, [workspace.id]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className={`${PANEL} p-4 space-y-3`}>
      <h3 className="text-[13px] font-semibold">Details</h3>
      <label className="block">
        <span className="text-[11px] uppercase text-text-muted tracking-wider">Name</span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-full mt-1 h-8 bg-bg-input border border-border-strong rounded-md px-2.5 text-[13px] outline-none focus:border-accent-border"
        />
      </label>
      <label className="block">
        <span className="text-[11px] uppercase text-text-muted tracking-wider">Description</span>
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className="w-full mt-1 h-8 bg-bg-input border border-border-strong rounded-md px-2.5 text-[13px] outline-none focus:border-accent-border"
        />
      </label>
      <div className="flex justify-end">
        <button
          disabled={!isDirty}
          onClick={() => onSave({ name, description: description || undefined })}
          className={cn(BTN_PRIMARY, !isDirty && 'opacity-40 cursor-not-allowed')}
        >
          Save
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// API Keys panel
// ---------------------------------------------------------------------------

function ApiKeysPanel({ workspaceId }: { workspaceId: string }) {
  const keys = useWorkspaceStore((s) => s.apiKeysByWorkspace[workspaceId] ?? []);
  const loading = useWorkspaceStore((s) => s.apiKeysLoading[workspaceId] ?? false);
  const fetchApiKeys = useWorkspaceStore((s) => s.fetchApiKeys);
  const createApiKey = useWorkspaceStore((s) => s.createApiKey);
  const revokeApiKey = useWorkspaceStore((s) => s.revokeApiKey);
  const newlyCreatedKey = useWorkspaceStore((s) => s.newlyCreatedKey);
  const clearNewlyCreatedKey = useWorkspaceStore((s) => s.clearNewlyCreatedKey);

  const [label, setLabel] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    fetchApiKeys(workspaceId);
    // Clear any previously-revealed secret when switching workspaces
    clearNewlyCreatedKey();
  }, [workspaceId, fetchApiKeys, clearNewlyCreatedKey]);

  const handleCreate = useCallback(async () => {
    if (!label.trim()) return;
    const key = await createApiKey(workspaceId, label.trim());
    if (key) setLabel('');
  }, [label, workspaceId, createApiKey]);

  const handleCopy = useCallback((key: string) => {
    navigator.clipboard.writeText(key);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, []);

  return (
    <div className={`${PANEL} p-4 space-y-3`}>
      <div className="flex items-center justify-between">
        <h3 className="text-[13px] font-semibold flex items-center gap-2">
          <Key size={14} />
          API Keys
        </h3>
        <span className="text-[11px] text-text-muted">{keys.length} active</span>
      </div>

      {/* Newly-created key banner */}
      {newlyCreatedKey && newlyCreatedKey.workspaceId === workspaceId && (
        <div className="bg-amber/10 border border-amber/40 rounded-md p-3 space-y-2">
          <div className="flex items-start gap-2">
            <AlertTriangle size={14} className="text-amber shrink-0 mt-0.5" />
            <div className="text-[12px] text-text-primary">
              <div className="font-semibold">Copy this secret now — it won't be shown again.</div>
              <div className="text-text-tertiary mt-0.5">
                Use it in a DSN: <code className="font-mono text-[11px]">runtimescope://proj_xxx:{newlyCreatedKey.key.slice(0, 12)}...@host/app</code>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <code className="flex-1 font-mono text-[12px] bg-bg-input px-2 py-1.5 rounded border border-border-strong overflow-x-auto">
              {newlyCreatedKey.key}
            </code>
            <button
              onClick={() => handleCopy(newlyCreatedKey.key)}
              className={BTN_GHOST}
              title="Copy to clipboard"
            >
              {copied ? <Check size={12} /> : <Copy size={12} />}
              {copied ? 'Copied' : 'Copy'}
            </button>
            <button onClick={clearNewlyCreatedKey} className={BTN_GHOST}>
              Done
            </button>
          </div>
        </div>
      )}

      {/* New key creator */}
      <div className="flex gap-2">
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') handleCreate(); }}
          placeholder="Label (e.g. 'CI server', 'Production backend')"
          className="flex-1 h-8 bg-bg-input border border-border-strong rounded-md px-2.5 text-[13px] outline-none focus:border-accent-border"
        />
        <button
          onClick={handleCreate}
          disabled={!label.trim()}
          className={cn(BTN_PRIMARY, !label.trim() && 'opacity-40 cursor-not-allowed')}
        >
          <Plus size={12} />
          Create key
        </button>
      </div>

      {/* Existing keys */}
      {loading && keys.length === 0 && (
        <div className="text-[12px] text-text-muted py-3">Loading…</div>
      )}
      {!loading && keys.length === 0 && (
        <div className="text-[12px] text-text-muted py-3">
          No API keys yet. Create one to let SDKs authenticate with this workspace.
        </div>
      )}
      {keys.length > 0 && (
        <div className="space-y-1">
          {keys.map((key) => (
            <div
              key={key.key}
              className="flex items-center gap-3 px-3 py-2 rounded-md hover:bg-bg-hover group"
            >
              <div className="flex-1 min-w-0">
                <div className="text-[13px] font-medium text-text-primary">{key.label}</div>
                <div className="text-[11px] text-text-muted font-mono truncate">
                  {key.key.slice(0, 12)}…{key.key.slice(-4)}
                  {' · created '}
                  {new Date(key.createdAt).toLocaleDateString()}
                  {key.lastUsedAt && ` · last used ${new Date(key.lastUsedAt).toLocaleString()}`}
                </div>
              </div>
              <button
                onClick={() => {
                  if (confirm(`Revoke key "${key.label}"? SDKs using it will stop authenticating.`)) {
                    revokeApiKey(key.key, workspaceId);
                  }
                }}
                className={`${BTN_DANGER} opacity-0 group-hover:opacity-100`}
              >
                <Trash2 size={12} />
                Revoke
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
