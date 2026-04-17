import { useState, useEffect, useCallback } from 'react';
import { usePmStore } from '@/stores/use-pm-store';
import { fetchGitDiff } from '@/lib/pm-api';
import { Badge, Button, EmptyState } from '@/components/ui';
import {
  GitBranch,
  RefreshCw,
  Plus,
  Minus,
  Check,
  ChevronRight,
  GitCommitHorizontal,
  FolderOpen,
  Loader2,
  FileDiff,
} from 'lucide-react';
import { cn } from '@/lib/cn';
import type { GitFileChange, GitFileStatus } from '@/lib/pm-types';

// ---------------------------------------------------------------------------
// Status colors
// ---------------------------------------------------------------------------

const STATUS_COLORS: Record<GitFileStatus, string> = {
  M: 'text-amber', A: 'text-green', D: 'text-red',
  R: 'text-blue', C: 'text-blue', U: 'text-orange', '?': 'text-text-muted',
};

// ---------------------------------------------------------------------------
// File Item
// ---------------------------------------------------------------------------

function FileItem({
  file, onAction, actionIcon, onSelect, isSelected,
}: {
  file: GitFileChange;
  onAction: () => void;
  actionIcon: React.ReactNode;
  onSelect: () => void;
  isSelected: boolean;
}) {
  return (
    <div
      onClick={onSelect}
      className={cn(
        'flex items-center gap-2 py-[5px] px-3.5 pl-7 cursor-pointer transition-colors group',
        isSelected ? 'bg-bg-active' : 'hover:bg-bg-hover',
      )}
    >
      <span className={cn('font-mono text-[11px] font-bold w-4 text-center shrink-0', STATUS_COLORS[file.status])}>
        {file.status}
      </span>
      <span className="flex-1 font-mono text-[12px] text-text-secondary truncate" title={file.path}>
        {file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
      </span>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onAction(); }}
        className="hidden group-hover:flex w-5 h-5 items-center justify-center rounded text-text-muted hover:text-accent hover:bg-bg-overlay transition-all cursor-pointer"
      >
        {actionIcon}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Collapsible Section
// ---------------------------------------------------------------------------

function FileSection({
  title, count, defaultOpen, actionIcon, onAction, children,
}: {
  title: string; count: number; defaultOpen?: boolean;
  actionIcon?: React.ReactNode; onAction?: () => void;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen ?? true);
  if (count === 0) return null;

  return (
    <div className="border-b border-border-muted last:border-b-0">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 w-full px-3.5 py-2 hover:bg-bg-hover transition-colors cursor-pointer select-none"
      >
        <ChevronRight size={12} className={cn('text-text-disabled transition-transform shrink-0', open && 'rotate-90')} />
        <span className="text-[11px] font-semibold text-text-muted uppercase tracking-wider flex-1 text-left">{title}</span>
        <span className="text-[10px] font-semibold text-text-muted bg-bg-overlay px-1.5 py-px rounded-full">{count}</span>
        {actionIcon && onAction && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onAction(); }}
            className="w-[22px] h-[22px] rounded flex items-center justify-center text-text-disabled hover:text-text-primary hover:bg-bg-hover transition-all cursor-pointer"
          >
            {actionIcon}
          </button>
        )}
      </button>
      {open && children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Commit Row (with timeline dot)
// ---------------------------------------------------------------------------

function CommitRow({ shortHash, subject, message, author, relativeDate, refs, isSelected, onSelect, isFirst }: {
  shortHash: string; subject: string; message: string; author: string;
  relativeDate: string; refs: string; isSelected: boolean; onSelect: () => void; isFirst: boolean;
}) {
  return (
    <div
      onClick={onSelect}
      className={cn(
        'flex items-start gap-2.5 px-3.5 py-2 pl-5 cursor-pointer transition-colors relative',
        isSelected ? 'bg-bg-active' : 'hover:bg-bg-hover',
      )}
    >
      {/* Timeline line */}
      <span className="absolute left-[25px] top-0 bottom-0 w-px bg-border-muted" />
      {/* Timeline dot */}
      <span className={cn(
        'w-[9px] h-[9px] rounded-full border-2 border-bg-app shrink-0 mt-1 z-[1] relative',
        isFirst ? 'bg-accent' : 'bg-text-muted',
      )} />
      <div className="flex-1 min-w-0">
        <div className="text-[12px] font-medium text-text-primary truncate">{subject}</div>
        <div className="flex items-center gap-1.5 mt-0.5">
          <span className="font-mono text-[11px] text-accent font-medium">{shortHash}</span>
          {refs && (
            <span className="text-[10px] font-semibold px-1.5 py-px rounded-full bg-accent-muted border border-accent-border text-accent font-mono">
              {refs.split(',')[0].trim()}
            </span>
          )}
          <span className="text-[11px] text-text-muted">{author}</span>
          <span className="text-[11px] text-text-disabled ml-auto shrink-0">{relativeDate}</span>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Diff Viewer
// ---------------------------------------------------------------------------

function DiffView({ diff }: { diff: string }) {
  if (!diff) return <div className="p-5 text-[13px] text-text-muted">No diff to display</div>;

  const lines = diff.split('\n');
  let lineNum = 0;

  return (
    <div className="font-mono text-[12px] leading-[1.65] whitespace-pre min-w-fit">
      {lines.map((line, i) => {
        let cls = '';
        let num = '';

        if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('---') || line.startsWith('+++')) {
          cls = 'meta';
        } else if (line.startsWith('@@')) {
          cls = 'hunk';
          const m = line.match(/@@ -\d+(?:,\d+)? \+(\d+)/);
          if (m) lineNum = parseInt(m[1]) - 1;
        } else if (line.startsWith('+')) {
          cls = 'added';
          lineNum++;
          num = String(lineNum);
        } else if (line.startsWith('-')) {
          cls = 'removed';
          num = '';
        } else {
          lineNum++;
          num = String(lineNum);
        }

        return (
          <div key={i} className={cn(
            'flex min-h-[20px]',
            cls === 'added' && 'bg-green-muted/60',
            cls === 'removed' && 'bg-red-muted/60',
            cls === 'hunk' && 'bg-blue-muted/60',
          )}>
            <span className={cn(
              'w-10 px-2 text-right text-[11px] select-none shrink-0',
              cls === 'added' ? 'text-green/40' : cls === 'removed' ? 'text-red/40' : 'text-text-disabled',
            )}>
              {num}
            </span>
            <span className={cn(
              'flex-1 px-3',
              cls === 'added' ? 'text-green' :
              cls === 'removed' ? 'text-red' :
              cls === 'hunk' ? 'text-blue italic' :
              cls === 'meta' ? 'text-text-disabled' :
              'text-text-secondary',
            )}>
              {line || ' '}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Commit Detail
// ---------------------------------------------------------------------------

function CommitDetail({ commit }: { commit: { hash: string; shortHash: string; subject: string; message: string; author: string; relativeDate: string; refs: string } | null }) {
  if (!commit) return null;
  const bodyLines = commit.message.split('\n').slice(1).join('\n').trim();

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2.5 px-4 py-3 border-b border-border-muted">
        <span className="text-[11px] font-semibold px-2 py-0.5 rounded bg-accent-muted text-accent">Commit</span>
        <span className="text-[12px] font-medium text-text-primary flex-1 truncate">{commit.subject}</span>
      </div>
      <div className="flex-1 overflow-y-auto p-5 space-y-4">
        <div className="font-mono text-[13px] text-accent font-medium">{commit.shortHash}</div>
        <div className="text-[16px] font-semibold text-text-primary leading-snug">{commit.subject}</div>
        {bodyLines && (
          <pre className="font-mono text-[12px] text-text-tertiary leading-relaxed whitespace-pre-wrap p-3.5 bg-bg-elevated border border-border-muted rounded-md">{bodyLines}</pre>
        )}
        <div className="p-3.5 bg-bg-elevated border border-border-muted rounded-md space-y-2">
          <div className="flex items-center justify-between text-[12px]">
            <span className="text-text-muted">Author</span>
            <span className="text-text-primary font-medium">{commit.author}</span>
          </div>
          <div className="flex items-center justify-between text-[12px]">
            <span className="text-text-muted">Date</span>
            <span className="text-text-primary font-medium">{commit.relativeDate}</span>
          </div>
          {commit.refs && (
            <div className="flex items-center justify-between text-[12px]">
              <span className="text-text-muted">Refs</span>
              <span className="text-[10px] font-semibold px-1.5 py-px rounded-full bg-accent-muted border border-accent-border text-accent font-mono">
                {commit.refs}
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Git Page
// ---------------------------------------------------------------------------

export function GitPage({ projectId, projectPath }: { projectId: string; projectPath?: string }) {
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

  useEffect(() => {
    fetchGitStatus(projectId);
    fetchGitCommits(projectId);
  }, [projectId, fetchGitStatus, fetchGitCommits]);

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
    setSelectedCommitHash(null);
  }, [projectId, fetchGitStatus, fetchGitCommits]);

  const handleCommit = useCallback(async () => {
    if (!commitMessage.trim()) return;
    setCommitting(true);
    const ok = await createCommit(projectId, commitMessage);
    if (ok) { setCommitMessage(''); setSelectedFile(null); }
    setCommitting(false);
  }, [projectId, commitMessage, createCommit]);

  if (!projectPath) {
    return <EmptyState icon={<FolderOpen size={32} />} title="No Project Path" description="This project doesn't have a filesystem path configured." />;
  }
  if (gitStatus && !gitStatus.isGitRepo) {
    return <EmptyState icon={<GitBranch size={32} />} title="Not a Git Repository" description="This project directory is not a git repository." />;
  }

  const totalChanges = (gitStatus?.staged.length ?? 0) + (gitStatus?.unstaged.length ?? 0) + (gitStatus?.untracked.length ?? 0);

  return (
    <div className="flex-1 flex min-h-0 overflow-hidden p-5">
      <div className="flex-1 border border-border-strong rounded-lg overflow-hidden flex min-h-0">

        {/* ── Left panel: status + commits ── */}
        <div className="w-[380px] shrink-0 bg-bg-app border-r border-border-muted flex flex-col min-h-0">
          {/* Branch bar */}
          <div className="flex items-center gap-2 px-3.5 py-3 border-b border-border-muted shrink-0">
            {gitStatus?.branch && (
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-accent-muted border border-accent-border text-accent text-[12px] font-semibold font-mono">
                <GitBranch size={13} />
                {gitStatus.branch}
              </span>
            )}
            {totalChanges > 0 && (
              <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-amber-muted text-amber">
                {totalChanges} change{totalChanges !== 1 ? 's' : ''}
              </span>
            )}
            <button
              type="button"
              onClick={handleRefresh}
              disabled={gitStatusLoading}
              className="ml-auto h-7 px-2 text-[11px] font-medium text-text-tertiary bg-bg-surface border border-border-default rounded-md inline-flex items-center gap-1 hover:border-border-hover hover:text-text-primary transition-colors cursor-pointer"
            >
              <RefreshCw size={12} className={gitStatusLoading ? 'animate-spin' : ''} />
            </button>
          </div>

          {/* Commit message */}
          <div className="px-3.5 py-3 border-b border-border-muted shrink-0">
            <textarea
              value={commitMessage}
              onChange={(e) => setCommitMessage(e.target.value)}
              placeholder="Commit message..."
              rows={2}
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); handleCommit(); } }}
              className="w-full h-[60px] p-2.5 bg-bg-input border border-border-strong rounded-md text-[12px] text-text-primary font-sans resize-none outline-none placeholder:text-text-muted focus:border-accent-border mb-2"
            />
            <div className="flex items-center gap-1.5">
              <Button
                size="sm"
                variant="primary"
                onClick={handleCommit}
                disabled={committing || !commitMessage.trim() || !gitStatus || gitStatus.staged.length === 0}
                className="h-7 px-3 text-[11px]"
              >
                {committing ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
                Commit
              </Button>
              <span className="text-[10px] text-text-disabled font-mono ml-auto">Cmd+Enter</span>
            </div>
          </div>

          {/* File sections + commits */}
          <div className="flex-1 overflow-y-auto">
            {gitStatusLoading && !gitStatus && (
              <div className="flex items-center justify-center py-8 text-text-muted text-[13px]">
                <Loader2 size={16} className="animate-spin mr-2" /> Loading...
              </div>
            )}

            {gitStatus && (
              <>
                <FileSection title="Staged" count={gitStatus.staged.length} actionIcon={<Minus size={12} />} onAction={() => unstageFiles(projectId)}>
                  {gitStatus.staged.map((f) => (
                    <FileItem key={`s-${f.path}`} file={f} onAction={() => unstageFiles(projectId, [f.path])} actionIcon={<Minus size={12} />}
                      onSelect={() => { setSelectedFile({ path: f.path, staged: true }); setSelectedCommitHash(null); }}
                      isSelected={selectedFile?.path === f.path && selectedFile?.staged === true} />
                  ))}
                </FileSection>

                <FileSection title="Changes" count={gitStatus.unstaged.length} actionIcon={<Plus size={12} />} onAction={() => stageFiles(projectId)}>
                  {gitStatus.unstaged.map((f) => (
                    <FileItem key={`u-${f.path}`} file={f} onAction={() => stageFiles(projectId, [f.path])} actionIcon={<Plus size={12} />}
                      onSelect={() => { setSelectedFile({ path: f.path, staged: false }); setSelectedCommitHash(null); }}
                      isSelected={selectedFile?.path === f.path && selectedFile?.staged === false} />
                  ))}
                </FileSection>

                <FileSection title="Untracked" count={gitStatus.untracked.length} defaultOpen={false} actionIcon={<Plus size={12} />} onAction={() => stageFiles(projectId)}>
                  {gitStatus.untracked.map((f) => (
                    <FileItem key={`t-${f.path}`} file={f} onAction={() => stageFiles(projectId, [f.path])} actionIcon={<Plus size={12} />}
                      onSelect={() => { setSelectedFile({ path: f.path, staged: false }); setSelectedCommitHash(null); }}
                      isSelected={selectedFile?.path === f.path && selectedFile?.staged === false} />
                  ))}
                </FileSection>

                {totalChanges === 0 && !gitStatusLoading && (
                  <div className="px-4 py-6 text-center text-[13px] text-text-muted">Working tree clean</div>
                )}
              </>
            )}

            {/* Recent commits */}
            <FileSection title="Recent Commits" count={gitCommits.length}>
              {gitCommitsLoading && gitCommits.length === 0 ? (
                <div className="px-4 py-3 text-[12px] text-text-muted">Loading commits...</div>
              ) : (
                gitCommits.map((c, i) => (
                  <CommitRow
                    key={c.hash}
                    {...c}
                    isFirst={i === 0}
                    isSelected={selectedCommitHash === c.hash}
                    onSelect={() => { setSelectedCommitHash(c.hash); setSelectedFile(null); }}
                  />
                ))
              )}
            </FileSection>
          </div>
        </div>

        {/* ── Right panel: diff / commit detail ── */}
        <div className="flex-1 min-w-0 bg-bg-surface flex flex-col min-h-0">
          {selectedFile ? (
            <>
              <div className="flex items-center gap-2.5 px-4 py-3 border-b border-border-muted shrink-0">
                <span className={cn(
                  'text-[11px] font-semibold px-2 py-0.5 rounded',
                  selectedFile.staged ? 'bg-green-muted text-green' : 'bg-amber-muted text-amber',
                )}>
                  {selectedFile.staged ? 'Staged' : 'Unstaged'}
                </span>
                <span className="font-mono text-[12px] text-text-secondary flex-1 truncate">{selectedFile.path}</span>
              </div>
              <div className="flex-1 overflow-auto">
                {diffLoading ? (
                  <div className="flex items-center justify-center py-8 text-text-muted text-[13px]">
                    <Loader2 size={16} className="animate-spin mr-2" /> Loading diff...
                  </div>
                ) : (
                  <DiffView diff={diff} />
                )}
              </div>
            </>
          ) : selectedCommitHash ? (
            <CommitDetail commit={gitCommits.find((c) => c.hash === selectedCommitHash) ?? null} />
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center gap-2 text-text-muted">
              <FileDiff size={32} className="text-text-disabled" />
              <span className="text-[13px]">Select a file or commit to view details</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
