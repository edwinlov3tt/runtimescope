import { useState, useEffect, useCallback } from 'react';
import { usePmStore } from '@/stores/use-pm-store';
import { fetchGitDiff } from '@/lib/pm-api';
import { Badge, Button, DetailPanel, EmptyState, Textarea } from '@/components/ui';
import {
  GitBranch,
  RefreshCw,
  Plus,
  Minus,
  ChevronDown,
  ChevronRight,
  GitCommitHorizontal,
  FolderOpen,
  Loader2,
} from 'lucide-react';
import { cn } from '@/lib/cn';
import type { GitFileChange, GitFileStatus } from '@/lib/pm-types';

// ---------------------------------------------------------------------------
// Status color mapping
// ---------------------------------------------------------------------------

const STATUS_COLORS: Record<GitFileStatus, string> = {
  M: 'text-amber-400',
  A: 'text-green-400',
  D: 'text-red-400',
  R: 'text-blue-400',
  C: 'text-blue-400',
  U: 'text-orange-400',
  '?': 'text-text-muted',
};

const STATUS_LABELS: Record<GitFileStatus, string> = {
  M: 'Modified',
  A: 'Added',
  D: 'Deleted',
  R: 'Renamed',
  C: 'Copied',
  U: 'Unmerged',
  '?': 'Untracked',
};

// ---------------------------------------------------------------------------
// Diff viewer
// ---------------------------------------------------------------------------

function DiffView({ diff }: { diff: string }) {
  if (!diff) return <div className="p-4 text-sm text-text-muted">No diff to display</div>;

  const lines = diff.split('\n');
  return (
    <pre className="text-xs font-mono p-3 overflow-auto max-h-full">
      {lines.map((line, i) => {
        let cls = 'text-text-secondary';
        if (line.startsWith('+') && !line.startsWith('+++')) cls = 'text-green-400 bg-green-400/5';
        else if (line.startsWith('-') && !line.startsWith('---')) cls = 'text-red-400 bg-red-400/5';
        else if (line.startsWith('@@')) cls = 'text-blue-400';
        else if (line.startsWith('diff ') || line.startsWith('index ')) cls = 'text-text-muted';
        return (
          <div key={i} className={cn('px-2 leading-5', cls)}>
            {line || ' '}
          </div>
        );
      })}
    </pre>
  );
}

// ---------------------------------------------------------------------------
// File list item
// ---------------------------------------------------------------------------

function FileItem({
  file,
  onAction,
  actionIcon,
  actionTitle,
  onSelect,
  isSelected,
}: {
  file: GitFileChange;
  onAction: () => void;
  actionIcon: React.ReactNode;
  actionTitle: string;
  onSelect: () => void;
  isSelected: boolean;
}) {
  return (
    <div
      className={cn(
        'flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-bg-hover cursor-pointer group transition-colors',
        isSelected && 'bg-bg-hover'
      )}
      onClick={onSelect}
    >
      <span className={cn('font-medium w-4 text-center', STATUS_COLORS[file.status])}>
        {file.status}
      </span>
      <span className="flex-1 font-mono truncate text-text-primary" title={file.path}>
        {file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
      </span>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onAction();
        }}
        className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-bg-surface text-text-muted hover:text-text-primary transition-all cursor-pointer"
        title={actionTitle}
      >
        {actionIcon}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Collapsible section
// ---------------------------------------------------------------------------

function FileSection({
  title,
  count,
  defaultOpen,
  children,
}: {
  title: string;
  count: number;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen ?? true);

  if (count === 0) return null;

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 w-full px-3 py-1.5 text-xs font-medium text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer"
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        {title}
        <Badge variant="default" size="sm">{count}</Badge>
      </button>
      {open && children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Commit row in recent commits list
// ---------------------------------------------------------------------------

function CommitRow({ shortHash, subject, message, author, relativeDate, refs, isSelected, onSelect }: {
  shortHash: string;
  subject: string;
  message: string;
  author: string;
  relativeDate: string;
  refs: string;
  isSelected: boolean;
  onSelect: () => void;
}) {
  const hasBody = message !== subject;
  return (
    <div
      className={cn(
        'flex items-center gap-3 px-3 py-1.5 text-xs hover:bg-bg-hover transition-colors cursor-pointer group',
        isSelected && 'bg-bg-hover'
      )}
      onClick={onSelect}
    >
      <GitCommitHorizontal size={12} className="text-text-muted shrink-0" />
      <span className="font-mono text-brand shrink-0">{shortHash}</span>
      <span className="flex-1 truncate text-text-primary" title={subject}>
        {subject}
        {hasBody && <span className="text-text-muted ml-1">...</span>}
      </span>
      {refs && (
        <Badge variant="default" size="sm">{refs.split(',')[0].trim()}</Badge>
      )}
      <span className="text-text-muted shrink-0">{author}</span>
      <span className="text-text-muted shrink-0 w-16 text-right">{relativeDate}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Commit detail view (right panel)
// ---------------------------------------------------------------------------

function CommitDetail({ commit }: { commit: { hash: string; shortHash: string; subject: string; message: string; author: string; relativeDate: string; refs: string } | null }) {
  if (!commit) return null;

  const bodyLines = commit.message.split('\n').slice(1).join('\n').trim();

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-3 border-b border-border-default space-y-2">
        <div className="flex items-center gap-2">
          <GitCommitHorizontal size={14} className="text-text-muted" />
          <span className="font-mono text-brand text-xs">{commit.shortHash}</span>
          <span className="text-xs text-text-muted">{commit.author}</span>
          <span className="text-xs text-text-muted">{commit.relativeDate}</span>
          {commit.refs && (
            <Badge variant="default" size="sm">{commit.refs.split(',')[0].trim()}</Badge>
          )}
        </div>
        <div className="text-sm font-medium text-text-primary">{commit.subject}</div>
      </div>
      {bodyLines && (
        <div className="px-4 py-3 border-b border-border-default">
          <pre className="text-xs font-mono text-text-secondary whitespace-pre-wrap leading-5">{bodyLines}</pre>
        </div>
      )}
      <div className="flex-1 flex items-center justify-center text-text-muted text-xs">
        <span className="font-mono select-all">{commit.hash}</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main GitPage
// ---------------------------------------------------------------------------

interface GitPageProps {
  projectId: string;
  projectPath?: string;
}

export function GitPage({ projectId, projectPath }: GitPageProps) {
  const gitStatus = usePmStore((s) => s.gitStatus);
  const gitStatusLoading = usePmStore((s) => s.gitStatusLoading);
  const gitCommits = usePmStore((s) => s.gitCommits);
  const gitCommitsLoading = usePmStore((s) => s.gitCommitsLoading);
  const fetchGitStatus = usePmStore((s) => s.fetchGitStatus);
  const fetchGitCommits = usePmStore((s) => s.fetchGitCommits);
  const stageFiles = usePmStore((s) => s.stageFiles);
  const unstageFiles = usePmStore((s) => s.unstageFiles);
  const createCommit = usePmStore((s) => s.createGitCommit);

  const [commitMessage, setCommitMessage] = useState('');
  const [committing, setCommitting] = useState(false);
  const [selectedFile, setSelectedFile] = useState<{ path: string; staged: boolean } | null>(null);
  const [selectedCommitHash, setSelectedCommitHash] = useState<string | null>(null);
  const [diff, setDiff] = useState('');
  const [diffLoading, setDiffLoading] = useState(false);

  // Initial load
  useEffect(() => {
    fetchGitStatus(projectId);
    fetchGitCommits(projectId);
  }, [projectId, fetchGitStatus, fetchGitCommits]);

  // Load diff when file selected
  useEffect(() => {
    if (!selectedFile) { setDiff(''); return; }
    let cancelled = false;
    setDiffLoading(true);
    fetchGitDiff(projectId, { staged: selectedFile.staged, file: selectedFile.path }).then((d) => {
      if (!cancelled) { setDiff(d); setDiffLoading(false); }
    });
    return () => { cancelled = true; };
  }, [selectedFile, projectId]);

  const handleRefresh = useCallback(() => {
    fetchGitStatus(projectId);
    fetchGitCommits(projectId);
    setSelectedFile(null);
  }, [projectId, fetchGitStatus, fetchGitCommits]);

  const handleStageAll = useCallback(() => stageFiles(projectId), [projectId, stageFiles]);
  const handleUnstageAll = useCallback(() => unstageFiles(projectId), [projectId, unstageFiles]);

  const handleCommit = useCallback(async () => {
    if (!commitMessage.trim()) return;
    setCommitting(true);
    const ok = await createCommit(projectId, commitMessage);
    if (ok) { setCommitMessage(''); setSelectedFile(null); }
    setCommitting(false);
  }, [projectId, commitMessage, createCommit]);

  const handleStageFile = useCallback((path: string) => stageFiles(projectId, [path]), [projectId, stageFiles]);
  const handleUnstageFile = useCallback((path: string) => unstageFiles(projectId, [path]), [projectId, unstageFiles]);

  // Empty states
  if (!projectPath) {
    return <EmptyState icon={<FolderOpen size={32} />} title="No Project Path" description="This project doesn't have a filesystem path configured." />;
  }

  if (gitStatus && !gitStatus.isGitRepo) {
    return <EmptyState icon={<GitBranch size={32} />} title="Not a Git Repository" description="This project directory is not a git repository." />;
  }

  const totalChanges = (gitStatus?.staged.length ?? 0) + (gitStatus?.unstaged.length ?? 0) + (gitStatus?.untracked.length ?? 0);

  return (
    <div className="flex-1 flex min-h-0 overflow-hidden">
      {/* Left panel: status + commits */}
      <div className="w-[420px] min-w-[320px] border-r border-border-default flex flex-col overflow-hidden">
        {/* Header */}
        <div className="px-4 py-3 border-b border-border-default space-y-3">
          <div className="flex items-center gap-2">
            {gitStatus?.branch && (
              <Badge variant="default" size="sm">
                <GitBranch size={10} />
                {gitStatus.branch}
              </Badge>
            )}
            {totalChanges > 0 && (
              <Badge variant="amber" size="sm">{totalChanges} change{totalChanges !== 1 ? 's' : ''}</Badge>
            )}
            <div className="flex-1" />
            <Button
              size="sm"
              variant="ghost"
              onClick={handleRefresh}
              disabled={gitStatusLoading}
            >
              <RefreshCw size={12} className={gitStatusLoading ? 'animate-spin' : ''} />
              Refresh
            </Button>
          </div>

          {/* Commit box */}
          <Textarea
            value={commitMessage}
            onChange={(e) => setCommitMessage(e.target.value)}
            placeholder="Commit message..."
            rows={2}
            className="text-xs"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                handleCommit();
              }
            }}
          />
          <div className="flex items-center gap-2">
            <Button size="sm" variant="ghost" onClick={handleStageAll} disabled={!gitStatus || (gitStatus.unstaged.length === 0 && gitStatus.untracked.length === 0)}>
              <Plus size={10} />
              Stage All
            </Button>
            <Button size="sm" variant="ghost" onClick={handleUnstageAll} disabled={!gitStatus || gitStatus.staged.length === 0}>
              <Minus size={10} />
              Unstage All
            </Button>
            <div className="flex-1" />
            <Button
              size="sm"
              variant="primary"
              onClick={handleCommit}
              disabled={committing || !commitMessage.trim() || !gitStatus || gitStatus.staged.length === 0}
            >
              {committing ? <Loader2 size={10} className="animate-spin" /> : <GitCommitHorizontal size={10} />}
              Commit
            </Button>
          </div>
        </div>

        {/* File sections */}
        <div className="flex-1 overflow-y-auto">
          {gitStatusLoading && !gitStatus && (
            <div className="flex items-center justify-center py-8 text-text-muted text-sm">
              <Loader2 size={16} className="animate-spin mr-2" />
              Loading...
            </div>
          )}

          {gitStatus && (
            <>
              <FileSection title="Staged Changes" count={gitStatus.staged.length}>
                {gitStatus.staged.map((f) => (
                  <FileItem
                    key={`staged-${f.path}`}
                    file={f}
                    onAction={() => handleUnstageFile(f.path)}
                    actionIcon={<Minus size={12} />}
                    actionTitle="Unstage"
                    onSelect={() => { setSelectedFile({ path: f.path, staged: true }); setSelectedCommitHash(null); }}
                    isSelected={selectedFile?.path === f.path && selectedFile?.staged === true}
                  />
                ))}
              </FileSection>

              <FileSection title="Changes" count={gitStatus.unstaged.length}>
                {gitStatus.unstaged.map((f) => (
                  <FileItem
                    key={`unstaged-${f.path}`}
                    file={f}
                    onAction={() => handleStageFile(f.path)}
                    actionIcon={<Plus size={12} />}
                    actionTitle="Stage"
                    onSelect={() => { setSelectedFile({ path: f.path, staged: false }); setSelectedCommitHash(null); }}
                    isSelected={selectedFile?.path === f.path && selectedFile?.staged === false}
                  />
                ))}
              </FileSection>

              <FileSection title="Untracked" count={gitStatus.untracked.length} defaultOpen={false}>
                {gitStatus.untracked.map((f) => (
                  <FileItem
                    key={`untracked-${f.path}`}
                    file={f}
                    onAction={() => handleStageFile(f.path)}
                    actionIcon={<Plus size={12} />}
                    actionTitle="Stage"
                    onSelect={() => { setSelectedFile({ path: f.path, staged: false }); setSelectedCommitHash(null); }}
                    isSelected={selectedFile?.path === f.path && selectedFile?.staged === false}
                  />
                ))}
              </FileSection>

              {totalChanges === 0 && !gitStatusLoading && (
                <div className="px-4 py-6 text-center text-sm text-text-muted">
                  Working tree clean
                </div>
              )}
            </>
          )}

          {/* Recent commits */}
          <div className="border-t border-border-default mt-2">
            <FileSection title="Recent Commits" count={gitCommits.length}>
              {gitCommitsLoading && gitCommits.length === 0 ? (
                <div className="px-4 py-3 text-xs text-text-muted">Loading commits...</div>
              ) : (
                gitCommits.map((c) => (
                  <CommitRow
                    key={c.hash}
                    {...c}
                    isSelected={selectedCommitHash === c.hash}
                    onSelect={() => { setSelectedCommitHash(c.hash); setSelectedFile(null); }}
                  />
                ))
              )}
            </FileSection>
          </div>
        </div>
      </div>

      {/* Right panel: diff or commit detail */}
      <div className="flex-1 min-w-0 overflow-auto bg-bg-base">
        {selectedFile ? (
          <div className="flex flex-col h-full">
            <div className="px-4 py-2 border-b border-border-default flex items-center gap-2 text-xs">
              <span className={cn('font-medium', selectedFile.staged ? 'text-green-400' : 'text-amber-400')}>
                {selectedFile.staged ? 'Staged' : 'Unstaged'}
              </span>
              <span className="font-mono text-text-primary">{selectedFile.path}</span>
            </div>
            <div className="flex-1 overflow-auto">
              {diffLoading ? (
                <div className="flex items-center justify-center py-8 text-text-muted text-sm">
                  <Loader2 size={16} className="animate-spin mr-2" />
                  Loading diff...
                </div>
              ) : (
                <DiffView diff={diff} />
              )}
            </div>
          </div>
        ) : selectedCommitHash ? (
          <CommitDetail commit={gitCommits.find((c) => c.hash === selectedCommitHash) ?? null} />
        ) : (
          <div className="flex items-center justify-center h-full text-text-muted text-sm">
            Select a file to view diff
          </div>
        )}
      </div>
    </div>
  );
}
