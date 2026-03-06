import { useState, useEffect } from 'react';
import { usePmStore } from '@/stores/use-pm-store';
import { Button, Badge, EmptyState } from '@/components/ui';
import { Plus, Pin, Trash2 } from 'lucide-react';
import { cn } from '@/lib/cn';

export function NotesPage({ projectId }: { projectId: string }) {
  const notes = usePmStore((s) => s.notes);
  const notesLoading = usePmStore((s) => s.notesLoading);

  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editContent, setEditContent] = useState('');
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    usePmStore.getState().fetchNotes(projectId);
  }, [projectId]);

  const sortedNotes = [...notes].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return b.updatedAt - a.updatedAt;
  });

  const selectedNote = notes.find((n) => n.id === selectedNoteId) ?? null;

  const selectNote = (id: string) => {
    const note = notes.find((n) => n.id === id);
    if (!note) return;
    setSelectedNoteId(id);
    setEditTitle(note.title);
    setEditContent(note.content);
    setDirty(false);
  };

  const handleCreate = async () => {
    const note = await usePmStore.getState().createNote({
      title: 'Untitled',
      projectId,
    });
    if (note) {
      selectNote(note.id);
    }
  };

  const handleSave = async () => {
    if (!selectedNoteId) return;
    await usePmStore.getState().updateNote(selectedNoteId, {
      title: editTitle,
      content: editContent,
    });
    setDirty(false);
  };

  const handlePin = async () => {
    if (!selectedNote) return;
    await usePmStore.getState().updateNote(selectedNote.id, {
      pinned: !selectedNote.pinned,
    });
  };

  const handleDelete = async () => {
    if (!selectedNoteId) return;
    await usePmStore.getState().deleteNote(selectedNoteId);
    setSelectedNoteId(null);
    setEditTitle('');
    setEditContent('');
    setDirty(false);
  };

  const formatDate = (ts: number) => {
    const d = new Date(ts);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  };

  return (
    <div className="flex-1 flex min-h-0 overflow-hidden">
      {/* Left panel - Note list */}
      <div className="w-[280px] shrink-0 border-r border-border-default flex flex-col min-h-0">
        <div className="flex items-center justify-between px-3 py-3 border-b border-border-default">
          <h2 className="text-sm font-semibold text-text-primary">Notes</h2>
          <Button variant="ghost" size="sm" onClick={handleCreate}>
            <Plus size={14} />
            New
          </Button>
        </div>

        {sortedNotes.length === 0 && !notesLoading ? (
          <div className="p-4">
            <EmptyState
              title="No notes yet"
              description="Create a note to get started."
            />
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto">
            {sortedNotes.map((note) => (
              <button
                key={note.id}
                type="button"
                onClick={() => selectNote(note.id)}
                className={cn(
                  'px-3 py-2.5 cursor-pointer border-b border-border-muted hover:bg-bg-hover',
                  'w-full text-left',
                  note.id === selectedNoteId && 'bg-bg-active'
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium text-text-primary truncate">
                    {note.title}
                  </span>
                  {note.pinned && (
                    <Pin size={12} className="text-text-muted shrink-0" />
                  )}
                </div>
                <p className="text-xs text-text-muted truncate mt-0.5">
                  {note.content.split('\n')[0] || 'Empty note'}
                </p>
                <p className="text-xs text-text-tertiary mt-1">
                  {formatDate(note.updatedAt)}
                </p>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Right panel - Editor */}
      <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
        {!selectedNote ? (
          <div className="flex-1 flex items-center justify-center">
            <EmptyState
              title="Select a note"
              description="Choose a note from the list or create a new one."
            />
          </div>
        ) : (
          <>
            <input
              type="text"
              value={editTitle}
              onChange={(e) => {
                setEditTitle(e.target.value);
                setDirty(true);
              }}
              placeholder="Note title"
              className="w-full bg-transparent text-lg font-semibold text-text-primary px-4 pt-4 pb-2 outline-none"
            />

            <textarea
              value={editContent}
              onChange={(e) => {
                setEditContent(e.target.value);
                setDirty(true);
              }}
              placeholder="Start writing..."
              className="w-full flex-1 bg-transparent text-text-primary text-sm font-mono p-4 resize-none outline-none"
            />

            <div className="flex items-center justify-between px-4 py-3 border-t border-border-default">
              <div className="flex items-center gap-2">
                <Button variant="ghost" size="sm" onClick={handlePin}>
                  <Pin size={14} />
                  {selectedNote.pinned ? 'Unpin' : 'Pin'}
                </Button>
                <Button variant="danger" size="sm" onClick={handleDelete}>
                  <Trash2 size={14} />
                  Delete
                </Button>
              </div>
              <Button
                variant="primary"
                size="sm"
                onClick={handleSave}
                disabled={!dirty}
              >
                Save
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
