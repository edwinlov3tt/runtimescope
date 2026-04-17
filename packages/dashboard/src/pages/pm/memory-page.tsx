import { useState, useEffect } from 'react';
import { usePmStore } from '@/stores/use-pm-store';
import { Button, EmptyState } from '@/components/ui';
import {
  Plus,
  FileText,
  Trash2,
  Save,
  Download,
  MoreHorizontal,
  Folder,
} from 'lucide-react';
import { cn } from '@/lib/cn';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function parseMemoryType(content: string): string | null {
  const match = content.match(/^---[\s\S]*?type:\s*(\w+)[\s\S]*?---/);
  return match ? match[1] : null;
}

function parseMemoryName(content: string): string | null {
  const match = content.match(/^---[\s\S]*?name:\s*(.+?)[\s\S]*?---/);
  return match ? match[1].trim() : null;
}

function parseMemoryDescription(content: string): string | null {
  const match = content.match(/^---[\s\S]*?description:\s*(.+?)[\s\S]*?---/);
  return match ? match[1].trim() : null;
}

const TYPE_STYLES: Record<string, { bg: string; text: string }> = {
  user:      { bg: 'bg-blue-muted', text: 'text-blue' },
  feedback:  { bg: 'bg-green-muted', text: 'text-green' },
  project:   { bg: 'bg-purple-muted', text: 'text-purple' },
  reference: { bg: 'bg-amber-muted', text: 'text-amber' },
};

// ---------------------------------------------------------------------------
// Memory Page
// ---------------------------------------------------------------------------

export function MemoryPage({
  projectId,
  claudeProjectKey,
}: {
  projectId: string;
  claudeProjectKey?: string;
}) {
  const memoryFiles = usePmStore((s) => s.memoryFiles);
  const memoryLoading = usePmStore((s) => s.memoryLoading);

  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [editContent, setEditContent] = useState('');
  const [dirty, setDirty] = useState(false);
  const [mode, setMode] = useState<'preview' | 'edit'>('preview');
  const [newFilePrompt, setNewFilePrompt] = useState(false);
  const [newFileName, setNewFileName] = useState('');

  useEffect(() => {
    if (claudeProjectKey) {
      usePmStore.getState().fetchMemoryFiles(projectId);
    }
  }, [projectId, claudeProjectKey]);

  useEffect(() => {
    if (selectedFile) {
      const file = memoryFiles.find((f) => f.filename === selectedFile);
      if (file) {
        setEditContent(file.content);
        setDirty(false);
      }
    }
  }, [selectedFile, memoryFiles]);

  const currentFile = selectedFile ? memoryFiles.find((f) => f.filename === selectedFile) : null;
  const memoryType = currentFile ? parseMemoryType(currentFile.content) : null;
  const memoryName = currentFile ? parseMemoryName(currentFile.content) : null;
  const memoryDesc = currentFile ? parseMemoryDescription(currentFile.content) : null;
  const typeStyle = memoryType ? TYPE_STYLES[memoryType] : null;

  const handleSave = async () => {
    if (!selectedFile) return;
    await usePmStore.getState().saveMemoryFile(projectId, selectedFile, editContent);
    setDirty(false);
  };

  const handleDelete = async () => {
    if (!selectedFile) return;
    await usePmStore.getState().deleteMemoryFile(projectId, selectedFile);
    setSelectedFile(null);
    setEditContent('');
    setDirty(false);
  };

  const handleNewFile = async () => {
    const name = newFileName.trim();
    if (!name) return;
    const filename = name.endsWith('.md') ? name : `${name}.md`;
    await usePmStore.getState().saveMemoryFile(projectId, filename, '---\nname: \ndescription: \ntype: user\n---\n\n');
    setNewFilePrompt(false);
    setNewFileName('');
    setSelectedFile(filename);
    setMode('edit');
  };

  const handleDownload = () => {
    if (!currentFile) return;
    const blob = new Blob([currentFile.content], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = currentFile.filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (!claudeProjectKey) {
    return (
      <EmptyState
        icon={<FileText size={32} />}
        title="No Claude project linked"
        description="Link a Claude project to manage memory files. Memory files help Claude remember context across conversations."
      />
    );
  }

  return (
    <div className="flex-1 flex min-h-0 overflow-hidden p-5">
      <div className="flex-1 border border-border-strong rounded-lg overflow-hidden flex min-h-0">

        {/* ── File Tree (left) ── */}
        <div className="w-[240px] shrink-0 bg-bg-app border-r border-border-muted flex flex-col min-h-0">
          <div className="flex items-center justify-between px-3.5 py-3 border-b border-border-muted shrink-0">
            <span className="text-[12px] font-semibold text-text-secondary">Memory Files</span>
            <button
              type="button"
              onClick={() => setNewFilePrompt(true)}
              className="w-[26px] h-[26px] rounded-md flex items-center justify-center text-text-muted hover:text-accent hover:bg-bg-hover transition-all cursor-pointer"
              title="New file"
            >
              <Plus size={14} />
            </button>
          </div>

          {/* Path indicator */}
          <div className="flex items-center gap-1 px-3.5 py-2 text-[11px] text-text-muted border-b border-border-muted shrink-0">
            <Folder size={11} />
            <span className="truncate">~/.claude/projects/.../memory/</span>
          </div>

          {/* New file input */}
          {newFilePrompt && (
            <div className="px-3 py-2 border-b border-border-muted shrink-0">
              <input
                type="text"
                className="w-full h-7 bg-bg-input text-text-primary text-[12px] rounded-md px-2.5 border border-border-strong outline-none focus:border-accent-border font-mono"
                placeholder="filename.md"
                value={newFileName}
                onChange={(e) => setNewFileName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleNewFile();
                  if (e.key === 'Escape') { setNewFilePrompt(false); setNewFileName(''); }
                }}
                autoFocus
              />
            </div>
          )}

          {/* File list */}
          <div className="flex-1 overflow-y-auto p-1">
            {memoryLoading && <p className="px-3 py-4 text-[11px] text-text-muted">Loading...</p>}
            {!memoryLoading && memoryFiles.length === 0 && (
              <p className="px-3 py-4 text-[11px] text-text-muted">No memory files yet</p>
            )}
            {memoryFiles.map((file) => {
              const isActive = selectedFile === file.filename;
              return (
                <button
                  key={file.filename}
                  type="button"
                  onClick={() => { setSelectedFile(file.filename); setMode('preview'); }}
                  className={cn(
                    'w-full flex items-center gap-2 px-2.5 py-2 rounded-md text-left transition-colors cursor-pointer',
                    isActive ? 'bg-accent-muted' : 'hover:bg-bg-hover',
                  )}
                >
                  <FileText size={15} className={cn('shrink-0', isActive ? 'text-accent' : 'text-text-muted')} />
                  <div className="flex-1 min-w-0">
                    <div className={cn('text-[12px] font-medium truncate', isActive ? 'text-accent' : 'text-text-primary')}>
                      {file.filename}
                    </div>
                    <div className="text-[10px] text-text-disabled mt-0.5">
                      {formatSize(file.sizeBytes)}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* ── Content Area (center) ── */}
        <div className="flex-1 flex flex-col min-h-0 bg-bg-surface">
          {!selectedFile ? (
            <EmptyState
              icon={<FileText size={28} />}
              title="Select a memory file"
              description="Choose a file from the list or create a new one."
            />
          ) : (
            <>
              {/* Header */}
              <div className="flex items-center gap-2.5 px-5 py-3 border-b border-border-muted shrink-0">
                <FileText size={16} className="text-text-muted shrink-0" />
                <span className="text-[14px] font-semibold text-text-primary flex-1">{selectedFile}</span>

                {/* Mode toggle */}
                <div className="flex bg-bg-elevated border border-border-default rounded-md p-0.5">
                  <button
                    onClick={() => setMode('preview')}
                    className={cn(
                      'px-2.5 py-1 text-[11px] font-medium rounded transition-colors cursor-pointer',
                      mode === 'preview' ? 'bg-bg-overlay text-text-primary' : 'text-text-muted hover:text-text-secondary',
                    )}
                  >
                    Preview
                  </button>
                  <button
                    onClick={() => setMode('edit')}
                    className={cn(
                      'px-2.5 py-1 text-[11px] font-medium rounded transition-colors cursor-pointer',
                      mode === 'edit' ? 'bg-bg-overlay text-text-primary' : 'text-text-muted hover:text-text-secondary',
                    )}
                  >
                    Edit
                  </button>
                </div>

                <button
                  onClick={handleDownload}
                  className="h-[28px] px-2 text-[11px] font-medium text-text-tertiary bg-bg-surface border border-border-default rounded-md inline-flex items-center gap-1.5 hover:border-border-hover hover:text-text-primary transition-colors cursor-pointer"
                >
                  <Download size={11} /> Download
                </button>
              </div>

              {/* Content */}
              {mode === 'edit' ? (
                <>
                  <textarea
                    className="w-full flex-1 bg-transparent text-text-primary text-[13px] font-mono p-5 resize-none outline-none leading-relaxed"
                    value={editContent}
                    onChange={(e) => { setEditContent(e.target.value); setDirty(true); }}
                    spellCheck={false}
                  />
                  <div className="flex items-center justify-between px-5 py-3 border-t border-border-muted shrink-0">
                    <Button variant="danger" size="sm" onClick={handleDelete}>
                      <Trash2 size={12} /> Delete
                    </Button>
                    <div className="flex items-center gap-2">
                      {dirty && <span className="text-[11px] text-amber">Unsaved changes</span>}
                      <Button variant="primary" size="sm" onClick={handleSave} disabled={!dirty}>
                        <Save size={12} /> Save
                      </Button>
                    </div>
                  </div>
                </>
              ) : (
                <div className="flex-1 overflow-y-auto px-8 py-6">
                  <div className="max-w-[720px] text-[14px] text-text-secondary leading-[1.7] whitespace-pre-wrap font-mono">
                    {currentFile?.content || '(empty file)'}
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* ── Metadata Sidebar (right) ── */}
        {selectedFile && currentFile && (
          <div className="w-[280px] shrink-0 bg-bg-app border-l border-border-muted overflow-y-auto hidden xl:block">
            {/* Document Info */}
            <div className="p-4 border-b border-border-muted">
              <div className="text-[11px] font-semibold text-text-muted uppercase tracking-wider mb-2.5">Document Info</div>
              <MetaRow label="File Size" value={formatSize(currentFile.sizeBytes)} />
              <MetaRow label="Format" value="Markdown" />
              <MetaRow label="Filename" value={currentFile.filename} mono />
            </div>

            {/* Frontmatter */}
            {(memoryName || memoryType || memoryDesc) && (
              <div className="p-4 border-b border-border-muted">
                <div className="text-[11px] font-semibold text-text-muted uppercase tracking-wider mb-2.5">Frontmatter</div>
                {memoryName && <MetaRow label="Name" value={memoryName} />}
                {memoryType && (
                  <div className="flex items-center justify-between py-1">
                    <span className="text-[12px] text-text-muted">Type</span>
                    <span className={cn(
                      'text-[10px] font-semibold px-2 py-0.5 rounded',
                      typeStyle?.bg ?? 'bg-bg-overlay',
                      typeStyle?.text ?? 'text-text-muted',
                    )}>
                      {memoryType}
                    </span>
                  </div>
                )}
                {memoryDesc && (
                  <p className="text-[11px] text-text-tertiary mt-2 leading-relaxed">{memoryDesc}</p>
                )}
              </div>
            )}

            {/* Actions */}
            <div className="p-4">
              <div className="text-[11px] font-semibold text-text-muted uppercase tracking-wider mb-2.5">Actions</div>
              <div className="space-y-1.5">
                <button
                  onClick={() => setMode('edit')}
                  className="w-full h-8 text-[12px] font-medium text-text-tertiary bg-bg-elevated border border-border-default rounded-md inline-flex items-center justify-center gap-1.5 hover:border-border-hover hover:text-text-primary transition-colors cursor-pointer"
                >
                  Edit File
                </button>
                <button
                  onClick={handleDelete}
                  className="w-full h-8 text-[12px] font-medium text-red bg-red-muted/50 border border-red-muted rounded-md inline-flex items-center justify-center gap-1.5 hover:bg-red-muted transition-colors cursor-pointer"
                >
                  <Trash2 size={11} /> Delete File
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Metadata row
// ---------------------------------------------------------------------------

function MetaRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between py-1">
      <span className="text-[12px] text-text-muted">{label}</span>
      <span className={cn('text-[12px] font-medium text-text-primary', mono && 'font-mono text-[11px]')}>{value}</span>
    </div>
  );
}
