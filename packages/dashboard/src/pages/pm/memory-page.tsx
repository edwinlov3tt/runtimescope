import { useState, useEffect } from 'react';
import { usePmStore } from '@/stores/use-pm-store';
import { Button, EmptyState } from '@/components/ui';
import { Plus, FileText, Trash2, Save } from 'lucide-react';
import { cn } from '@/lib/cn';

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

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
    await usePmStore.getState().saveMemoryFile(projectId, filename, '');
    setNewFilePrompt(false);
    setNewFileName('');
    setSelectedFile(filename);
  };

  return (
    <div className="flex-1 flex min-h-0 overflow-hidden">
      {/* Left panel - file list */}
      <div className="w-[240px] shrink-0 border-r border-border-default flex flex-col min-h-0">
        <div className="flex items-center justify-between px-3 py-3 border-b border-border-default">
          <h2 className="text-sm font-semibold text-text-primary">Memory Files</h2>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setNewFilePrompt(true)}
            disabled={!claudeProjectKey}
          >
            <Plus size={14} />
            New File
          </Button>
        </div>

        {newFilePrompt && (
          <div className="px-3 py-2 border-b border-border-muted">
            <input
              type="text"
              className="w-full bg-bg-overlay text-text-primary text-sm rounded px-2 py-1 border border-border-strong outline-none focus:border-brand"
              placeholder="filename"
              value={newFileName}
              onChange={(e) => setNewFileName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleNewFile();
                if (e.key === 'Escape') {
                  setNewFilePrompt(false);
                  setNewFileName('');
                }
              }}
              autoFocus
            />
          </div>
        )}

        <div className="flex-1 overflow-y-auto">
          {memoryLoading && (
            <p className="px-3 py-4 text-xs text-text-muted">Loading...</p>
          )}
          {!memoryLoading && memoryFiles.length === 0 && (
            <p className="px-3 py-4 text-xs text-text-muted">No memory files</p>
          )}
          {memoryFiles.map((file) => (
            <button
              key={file.filename}
              type="button"
              onClick={() => setSelectedFile(file.filename)}
              className={cn(
                'px-3 py-2 cursor-pointer border-b border-border-muted hover:bg-bg-hover flex items-center gap-2 w-full text-left',
                selectedFile === file.filename && 'bg-bg-hover'
              )}
            >
              <FileText size={14} className="text-text-muted shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-sm text-text-primary truncate">{file.filename}</p>
                <p className="text-xs text-text-muted">{formatSize(file.sizeBytes)}</p>
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Right panel - editor */}
      <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
        {!claudeProjectKey ? (
          <EmptyState
            icon={<FileText size={32} />}
            title="No Claude project linked"
            description="Link a Claude project to manage memory files."
          />
        ) : !selectedFile ? (
          <EmptyState
            icon={<FileText size={32} />}
            title="Select a memory file"
            description="Choose a file from the list or create a new one."
          />
        ) : (
          <>
            <div className="px-4 py-3 border-b border-border-default">
              <h3 className="text-sm font-semibold text-text-primary">{selectedFile}</h3>
              <p className="text-xs text-text-muted font-mono mt-0.5">
                ~/.claude/projects/{claudeProjectKey}/memory/{selectedFile}
              </p>
            </div>

            <textarea
              className="w-full flex-1 bg-transparent text-text-primary text-sm font-mono p-4 resize-none outline-none"
              value={editContent}
              onChange={(e) => {
                setEditContent(e.target.value);
                setDirty(true);
              }}
            />

            <div className="flex items-center justify-between px-4 py-2 border-t border-border-default">
              <Button variant="danger" size="sm" onClick={handleDelete}>
                <Trash2 size={14} />
                Delete
              </Button>
              <Button variant="primary" size="sm" onClick={handleSave} disabled={!dirty}>
                <Save size={14} />
                Save
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
