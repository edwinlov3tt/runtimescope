import { useState, useEffect, useCallback, useMemo } from 'react';
import { usePmStore } from '@/stores/use-pm-store';
import { Badge, Button, EmptyState } from '@/components/ui';
import { SearchInput } from '@/components/ui/input';
import {
  Plus,
  GripVertical,
  Trash2,
  Download,
  Kanban,
  FolderOpen,
  Sparkles,
  CheckSquare,
  Lightbulb,
  FileText,
  ExternalLink,
  ArrowRightCircle,
  RefreshCw,
  CheckCircle,
} from 'lucide-react';
import { cn } from '@/lib/cn';
import { RuntimeScope } from '@runtimescope/sdk';
import type { TaskStatus, TaskPriority, PmTask } from '@/lib/pm-types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const COLUMNS: { status: TaskStatus; label: string; dotColor: string }[] = [
  { status: 'todo', label: 'Todo', dotColor: 'bg-text-muted' },
  { status: 'in_progress', label: 'In Progress', dotColor: 'bg-blue' },
  { status: 'done', label: 'Done', dotColor: 'bg-green' },
];

const PRIORITY_VARIANT: Record<TaskPriority, 'default' | 'blue' | 'amber' | 'red'> = {
  low: 'default',
  medium: 'blue',
  high: 'amber',
  urgent: 'red',
};

const SOURCE_CONFIG: Record<string, { icon: typeof Sparkles; label: string; variant: 'purple' | 'default' | 'accent' }> = {
  claude_session: { icon: Sparkles, label: 'Claude', variant: 'purple' },
  github_issue: { icon: FileText, label: 'GitHub', variant: 'default' },
  file: { icon: FileText, label: 'File', variant: 'accent' },
};

const PRIORITY_OPTIONS: TaskPriority[] = ['low', 'medium', 'high', 'urgent'];

// ---------------------------------------------------------------------------
// Task Card
// ---------------------------------------------------------------------------

function TaskCard({
  task,
  onDragStart,
  onDelete,
}: {
  task: PmTask;
  onDragStart: (e: React.DragEvent, id: string) => void;
  onDelete: (id: string) => void;
}) {
  const srcCfg = SOURCE_CONFIG[task.source];

  return (
    <div
      draggable
      onDragStart={(e) => onDragStart(e, task.id)}
      className="bg-bg-surface border border-border-strong rounded-md p-2.5 cursor-grab active:cursor-grabbing transition-all hover:border-border-hover hover:bg-bg-elevated group"
    >
      <div className="flex items-start justify-between gap-2 mb-1.5">
        <div className="flex items-center gap-1.5 min-w-0 flex-1">
          <GripVertical size={12} className="shrink-0 text-text-disabled opacity-0 group-hover:opacity-100 transition-opacity" />
          <span className="text-[13px] font-medium text-text-primary leading-snug">{task.title}</span>
        </div>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onDelete(task.id); }}
          className="shrink-0 p-1 rounded text-text-disabled opacity-0 group-hover:opacity-100 hover:text-red hover:bg-red-muted transition-all cursor-pointer"
        >
          <Trash2 size={11} />
        </button>
      </div>

      <div className="flex items-center gap-1.5 flex-wrap">
        <Badge variant={PRIORITY_VARIANT[task.priority]} size="sm">
          {task.priority}
        </Badge>
        {task.labels.map((label) => (
          <span key={label} className="text-[9px] font-medium px-1.5 py-px rounded bg-bg-overlay text-text-muted">
            {label}
          </span>
        ))}
        {srcCfg && (
          <span className={cn(
            'text-[9px] font-medium px-1.5 py-px rounded inline-flex items-center gap-1',
            task.source === 'claude_session' ? 'bg-purple-muted text-purple' : 'bg-bg-overlay text-text-tertiary',
          )}>
            <srcCfg.icon size={9} />
            {srcCfg.label}
          </span>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Kanban Column
// ---------------------------------------------------------------------------

function KanbanColumn({
  status,
  label,
  dotColor,
  tasks,
  isDropTarget,
  onDragOver,
  onDragLeave,
  onDrop,
  onDragStart,
  onDelete,
  onQuickAdd,
}: {
  status: TaskStatus;
  label: string;
  dotColor: string;
  tasks: PmTask[];
  isDropTarget: boolean;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (e: React.DragEvent) => void;
  onDragStart: (e: React.DragEvent, id: string) => void;
  onDelete: (id: string) => void;
  onQuickAdd: (title: string) => void;
}) {
  const [quickTitle, setQuickTitle] = useState('');

  const handleQuickAdd = () => {
    const title = quickTitle.trim();
    if (!title) return;
    onQuickAdd(title);
    setQuickTitle('');
  };

  return (
    <div
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className={cn(
        'flex-1 min-w-[280px] bg-bg-app border rounded-lg flex flex-col',
        isDropTarget ? 'border-accent border-dashed' : 'border-border-default',
      )}
    >
      {/* Column header */}
      <div className="flex items-center gap-2 px-3.5 py-3 border-b border-border-muted shrink-0">
        <span className={cn('w-2 h-2 rounded-full shrink-0', dotColor)} />
        <span className="text-[12px] font-semibold text-text-secondary flex-1">{label}</span>
        <span className="text-[10px] font-semibold text-text-muted bg-bg-overlay px-1.5 py-px rounded-full">{tasks.length}</span>
      </div>

      {/* Cards */}
      <div className="flex-1 overflow-y-auto p-2 flex flex-col gap-1.5">
        {tasks.map((task) => (
          <TaskCard key={task.id} task={task} onDragStart={onDragStart} onDelete={onDelete} />
        ))}
      </div>

      {/* Quick add */}
      <div className="p-2 shrink-0">
        <input
          type="text"
          value={quickTitle}
          onChange={(e) => setQuickTitle(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleQuickAdd()}
          placeholder="+ Add task..."
          className="w-full h-8 px-2.5 bg-bg-surface border border-dashed border-border-strong rounded-md text-[12px] text-text-primary placeholder:text-text-disabled outline-none focus:border-accent-border focus:border-solid transition-colors"
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Files View — .claude/tasks and .claude/features
// ---------------------------------------------------------------------------

interface ClaudeFile {
  name: string;
  path: string;
  type: 'task' | 'feature';
  status: string;
  priority: string;
  effort: string;
  created: string;
}

const STATUS_STYLES: Record<string, { cls: string; label: string }> = {
  todo: { cls: 'bg-bg-overlay text-text-tertiary', label: 'Todo' },
  in_progress: { cls: 'bg-blue-muted text-blue', label: 'In Progress' },
  done: { cls: 'bg-green-muted text-green', label: 'Done' },
  backlog: { cls: 'bg-bg-overlay text-text-muted', label: 'Backlog' },
};

function FilesView({ projectId }: { projectId: string }) {
  // In production these come from the PM store — for now show a helpful empty state
  const [files] = useState<ClaudeFile[]>([]);
  const [selectedFile, setSelectedFile] = useState<ClaudeFile | null>(null);

  if (files.length === 0) {
    return (
      <div className="flex-1 border border-border-strong rounded-lg overflow-hidden bg-bg-surface flex">
        <div className="w-[280px] shrink-0 bg-bg-app border-r border-border-muted flex flex-col">
          <div className="flex items-center justify-between px-3.5 py-3 border-b border-border-muted shrink-0">
            <span className="text-[12px] font-semibold text-text-secondary">Project Files</span>
            <RefreshCw size={13} className="text-text-muted" />
          </div>
          <div className="flex-1 flex items-center justify-center p-6">
            <div className="text-center">
              <FileText size={24} className="text-text-disabled mx-auto mb-2" />
              <p className="text-[12px] text-text-muted mb-1">No task files found</p>
              <p className="text-[10px] text-text-disabled">
                Create files in <code className="px-1 py-0.5 bg-bg-overlay rounded text-[10px]">.claude/tasks/</code> or <code className="px-1 py-0.5 bg-bg-overlay rounded text-[10px]">.claude/features/</code>
              </p>
            </div>
          </div>
          {/* Quick draft composer */}
          <div className="p-3 border-t border-border-muted bg-bg-app shrink-0">
            <div className="flex gap-1.5">
              <input
                type="text"
                placeholder="Quick idea or task..."
                className="flex-1 h-[34px] px-2.5 bg-bg-input border border-border-strong rounded-md text-[12px] text-text-primary placeholder:text-text-muted outline-none focus:border-accent-border"
              />
              <Button variant="primary" size="sm" className="shrink-0 h-[34px] px-2.5">
                <Sparkles size={12} />
              </Button>
            </div>
            <p className="text-[10px] text-text-disabled mt-1.5 leading-relaxed">
              Type a rough idea — Claude will create a structured .md file
            </p>
          </div>
        </div>
        <div className="flex-1 flex items-center justify-center">
          <EmptyState
            icon={<FolderOpen size={28} />}
            title="Select a file"
            description="Choose a task or feature file from the sidebar to preview its contents."
          />
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 border border-border-strong rounded-lg overflow-hidden bg-bg-surface flex">
      {/* File sidebar */}
      <div className="w-[280px] shrink-0 bg-bg-app border-r border-border-muted flex flex-col">
        <div className="flex items-center justify-between px-3.5 py-3 border-b border-border-muted shrink-0">
          <span className="text-[12px] font-semibold text-text-secondary">Project Files</span>
          <RefreshCw size={13} className="text-text-muted" />
        </div>
        <div className="flex-1 overflow-y-auto p-1">
          {/* Tasks section */}
          <div className="flex items-center gap-1.5 px-2.5 py-1.5 text-[10px] font-semibold text-text-muted uppercase tracking-wider">
            <CheckSquare size={11} /> Tasks
          </div>
          {files.filter((f) => f.type === 'task').map((f) => (
            <button
              key={f.path}
              onClick={() => setSelectedFile(f)}
              className={cn(
                'w-full flex items-start gap-2.5 px-2.5 py-2 rounded-md text-left transition-colors cursor-pointer border border-transparent',
                selectedFile?.path === f.path ? 'bg-accent-muted border-accent-border' : 'hover:bg-bg-hover',
              )}
            >
              <div className="w-8 h-8 rounded-md bg-blue-muted flex items-center justify-center shrink-0">
                <CheckSquare size={14} className="text-blue" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-[12px] font-medium text-text-primary truncate">{f.name}</div>
                <div className="text-[10px] text-text-muted mt-0.5">{f.effort} &middot; {f.created}</div>
              </div>
              <span className={cn('text-[10px] font-semibold px-1.5 py-px rounded shrink-0', STATUS_STYLES[f.status]?.cls || 'bg-bg-overlay text-text-muted')}>
                {STATUS_STYLES[f.status]?.label || f.status}
              </span>
            </button>
          ))}

          {/* Features section */}
          <div className="flex items-center gap-1.5 px-2.5 py-1.5 mt-2 text-[10px] font-semibold text-text-muted uppercase tracking-wider">
            <Lightbulb size={11} /> Features
          </div>
          {files.filter((f) => f.type === 'feature').map((f) => (
            <button
              key={f.path}
              onClick={() => setSelectedFile(f)}
              className={cn(
                'w-full flex items-start gap-2.5 px-2.5 py-2 rounded-md text-left transition-colors cursor-pointer border border-transparent',
                selectedFile?.path === f.path ? 'bg-accent-muted border-accent-border' : 'hover:bg-bg-hover',
              )}
            >
              <div className="w-8 h-8 rounded-md bg-amber-muted flex items-center justify-center shrink-0">
                <Lightbulb size={14} className="text-amber" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-[12px] font-medium text-text-primary truncate">{f.name}</div>
                <div className="text-[10px] text-text-muted mt-0.5">{f.effort} &middot; {f.created}</div>
              </div>
              <span className={cn('text-[10px] font-semibold px-1.5 py-px rounded shrink-0', STATUS_STYLES[f.status]?.cls || 'bg-bg-overlay text-text-muted')}>
                {STATUS_STYLES[f.status]?.label || f.status}
              </span>
            </button>
          ))}
        </div>

        {/* Quick draft */}
        <div className="p-3 border-t border-border-muted bg-bg-app shrink-0">
          <div className="flex gap-1.5">
            <input
              type="text"
              placeholder="Quick idea or task..."
              className="flex-1 h-[34px] px-2.5 bg-bg-input border border-border-strong rounded-md text-[12px] text-text-primary placeholder:text-text-muted outline-none focus:border-accent-border"
            />
            <Button variant="primary" size="sm" className="shrink-0 h-[34px] px-2.5">
              <Sparkles size={12} />
            </Button>
          </div>
          <p className="text-[10px] text-text-disabled mt-1.5 leading-relaxed">
            Type a rough idea — Claude will create a structured .md file
          </p>
        </div>
      </div>

      {/* File preview */}
      <div className="flex-1 flex flex-col min-h-0">
        {selectedFile ? (
          <>
            <div className="flex items-center gap-2.5 px-5 py-3.5 border-b border-border-muted shrink-0">
              <FileText size={16} className="text-text-muted" />
              <span className="text-[14px] font-semibold text-text-primary flex-1">{selectedFile.name}</span>
              <span className={cn('text-[11px] font-medium px-2 py-0.5 rounded-full inline-flex items-center gap-1', STATUS_STYLES[selectedFile.status]?.cls)}>
                <CheckCircle size={11} />
                {STATUS_STYLES[selectedFile.status]?.label || selectedFile.status}
              </span>
              <button className="text-[11px] font-medium text-text-tertiary bg-bg-elevated border border-border-default rounded-md px-2 py-1 inline-flex items-center gap-1 hover:border-border-hover hover:text-text-primary transition-colors cursor-pointer">
                <ExternalLink size={11} /> Open
              </button>
              <button className="text-[11px] font-medium text-text-tertiary bg-bg-elevated border border-border-default rounded-md px-2 py-1 inline-flex items-center gap-1 hover:border-border-hover hover:text-text-primary transition-colors cursor-pointer">
                <ArrowRightCircle size={11} /> Add to Board
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-6">
              <p className="text-[13px] text-text-tertiary">File preview will render markdown content from {selectedFile.path}</p>
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <EmptyState
              icon={<FolderOpen size={28} />}
              title="Select a file"
              description="Choose a task or feature file to preview."
            />
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tasks Page
// ---------------------------------------------------------------------------

export function TasksPage({ projectId }: { projectId: string }) {
  const tasks = usePmStore((s) => s.tasks);
  const tasksLoading = usePmStore((s) => s.tasksLoading);
  const [activeView, setActiveView] = useState<'board' | 'files'>('board');
  const [search, setSearch] = useState('');
  const [dragOverColumn, setDragOverColumn] = useState<TaskStatus | null>(null);

  useEffect(() => {
    usePmStore.getState().fetchTasks(projectId);
  }, [projectId]);

  const projectTasks = useMemo(() =>
    tasks.filter((t) => t.projectId === projectId),
    [tasks, projectId],
  );

  const filteredTasks = useMemo(() => {
    if (!search.trim()) return projectTasks;
    const q = search.trim().toLowerCase();
    return projectTasks.filter((t) => t.title.toLowerCase().includes(q) || t.labels.some((l) => l.toLowerCase().includes(q)));
  }, [projectTasks, search]);

  const tasksByStatus = useCallback((status: TaskStatus) =>
    filteredTasks
      .filter((t) => t.status === status)
      .sort((a, b) => a.sortOrder - b.sortOrder),
    [filteredTasks],
  );

  const handleDragStart = (e: React.DragEvent, taskId: string) => {
    e.dataTransfer.setData('text/plain', taskId);
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleDrop = async (e: React.DragEvent, targetStatus: TaskStatus) => {
    e.preventDefault();
    setDragOverColumn(null);
    const taskId = e.dataTransfer.getData('text/plain');
    if (!taskId) return;
    const columnTasks = tasksByStatus(targetStatus);
    const newSortOrder = columnTasks.length === 0 ? 0 : columnTasks[columnTasks.length - 1].sortOrder + 1000;
    await usePmStore.getState().reorderTask(taskId, targetStatus, newSortOrder);
  };

  const handleDelete = async (taskId: string) => {
    await usePmStore.getState().deleteTask(taskId);
  };

  const handleQuickAdd = async (title: string, status: TaskStatus = 'todo') => {
    await usePmStore.getState().createTask({
      title,
      projectId,
      status,
      priority: 'medium',
    });
  };

  const handleExportCsv = useCallback(() => {
    if (projectTasks.length === 0) return;
    const headers = ['Title', 'Status', 'Priority', 'Labels', 'Created'];
    const rows = projectTasks.map((t: PmTask) => [
      `"${t.title.replace(/"/g, '""')}"`,
      t.status, t.priority, `"${t.labels.join(', ')}"`,
      new Date(t.createdAt).toISOString(),
    ]);
    const csv = [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `tasks-${projectId}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    RuntimeScope.track('export_csv', { projectId, taskCount: projectTasks.length });
  }, [projectTasks, projectId]);

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center gap-3 px-5 py-3 border-b border-border-default shrink-0">
        {/* View toggle */}
        <div className="flex items-center gap-0.5 bg-bg-surface border border-border-default rounded-md p-0.5">
          <button
            onClick={() => setActiveView('board')}
            className={cn(
              'h-[26px] px-2.5 rounded text-[12px] font-medium flex items-center gap-1.5 transition-colors cursor-pointer',
              activeView === 'board' ? 'bg-bg-overlay text-text-primary' : 'text-text-muted hover:text-text-secondary',
            )}
          >
            <Kanban size={14} /> Board
          </button>
          <button
            onClick={() => setActiveView('files')}
            className={cn(
              'h-[26px] px-2.5 rounded text-[12px] font-medium flex items-center gap-1.5 transition-colors cursor-pointer',
              activeView === 'files' ? 'bg-bg-overlay text-text-primary' : 'text-text-muted hover:text-text-secondary',
            )}
          >
            <FolderOpen size={14} /> Files
          </button>
        </div>

        {activeView === 'board' && (
          <div className="w-56">
            <SearchInput
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search tasks..."
            />
          </div>
        )}

        <div className="flex items-center gap-2 ml-auto">
          {projectTasks.length > 0 && (
            <button
              onClick={handleExportCsv}
              className="h-[34px] px-3 text-[12px] font-medium text-text-tertiary bg-bg-surface border border-border-default rounded-md inline-flex items-center gap-1.5 hover:border-border-hover hover:text-text-primary transition-colors cursor-pointer"
            >
              <Download size={13} /> Export CSV
            </button>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 flex flex-col min-h-0 p-5">
        {activeView === 'board' ? (
          !tasksLoading && projectTasks.length === 0 ? (
            <div className="flex-1 flex flex-col">
              {/* Show kanban with empty columns so quick-add is available */}
              <div className="flex-1 flex gap-4">
                {COLUMNS.map((col) => (
                  <KanbanColumn
                    key={col.status}
                    status={col.status}
                    label={col.label}
                    dotColor={col.dotColor}
                    tasks={[]}
                    isDropTarget={false}
                    onDragOver={(e) => { e.preventDefault(); setDragOverColumn(col.status); }}
                    onDragLeave={() => setDragOverColumn(null)}
                    onDrop={(e) => handleDrop(e, col.status)}
                    onDragStart={handleDragStart}
                    onDelete={handleDelete}
                    onQuickAdd={(title) => handleQuickAdd(title, col.status)}
                  />
                ))}
              </div>
            </div>
          ) : (
            <div className="flex-1 flex gap-4">
              {COLUMNS.map((col) => (
                <KanbanColumn
                  key={col.status}
                  status={col.status}
                  label={col.label}
                  dotColor={col.dotColor}
                  tasks={tasksByStatus(col.status)}
                  isDropTarget={dragOverColumn === col.status}
                  onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setDragOverColumn(col.status); }}
                  onDragLeave={() => setDragOverColumn(null)}
                  onDrop={(e) => handleDrop(e, col.status)}
                  onDragStart={handleDragStart}
                  onDelete={handleDelete}
                  onQuickAdd={(title) => handleQuickAdd(title, col.status)}
                />
              ))}
            </div>
          )
        ) : (
          <FilesView projectId={projectId} />
        )}
      </div>
    </div>
  );
}
