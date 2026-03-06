import { useState, useEffect, useCallback } from 'react';
import { usePmStore } from '@/stores/use-pm-store';
import { Badge, Button, EmptyState } from '@/components/ui';
import { Plus, GripVertical, Trash2, Download } from 'lucide-react';
import { cn } from '@/lib/cn';
import { RuntimeScope } from '@runtimescope/sdk';
import type { TaskStatus, TaskPriority, PmTask } from '@/lib/pm-types';

const COLUMNS: { status: TaskStatus; label: string }[] = [
  { status: 'todo', label: 'Todo' },
  { status: 'in_progress', label: 'In Progress' },
  { status: 'done', label: 'Done' },
];

const PRIORITY_VARIANT: Record<TaskPriority, 'default' | 'blue' | 'amber' | 'red'> = {
  low: 'default',
  medium: 'blue',
  high: 'amber',
  urgent: 'red',
};

const PRIORITY_OPTIONS: TaskPriority[] = ['low', 'medium', 'high', 'urgent'];

export function TasksPage({ projectId }: { projectId: string }) {
  const tasks = usePmStore((s) => s.tasks);
  const tasksLoading = usePmStore((s) => s.tasksLoading);

  const [newTitle, setNewTitle] = useState('');
  const [newPriority, setNewPriority] = useState<TaskPriority>('medium');
  const [dragOverColumn, setDragOverColumn] = useState<TaskStatus | null>(null);

  useEffect(() => {
    usePmStore.getState().fetchTasks(projectId);
  }, [projectId]);

  const tasksByStatus = (status: TaskStatus) =>
    tasks
      .filter((t) => t.status === status && t.projectId === projectId)
      .sort((a, b) => a.sortOrder - b.sortOrder);

  const handleCreate = async () => {
    const title = newTitle.trim();
    if (!title) return;
    await usePmStore.getState().createTask({
      title,
      projectId,
      status: 'todo',
      priority: newPriority,
    });
    setNewTitle('');
    setNewPriority('medium');
  };

  const handleDragStart = (e: React.DragEvent, taskId: string) => {
    e.dataTransfer.setData('text/plain', taskId);
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleDragOver = (e: React.DragEvent, status: TaskStatus) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOverColumn(status);
  };

  const handleDragLeave = () => {
    setDragOverColumn(null);
  };

  const handleDrop = async (e: React.DragEvent, targetStatus: TaskStatus) => {
    e.preventDefault();
    setDragOverColumn(null);

    const taskId = e.dataTransfer.getData('text/plain');
    if (!taskId) return;

    const columnTasks = tasksByStatus(targetStatus);
    let newSortOrder: number;

    if (columnTasks.length === 0) {
      newSortOrder = 0;
    } else {
      const lastTask = columnTasks[columnTasks.length - 1];
      newSortOrder = lastTask.sortOrder + 1000;
    }

    await usePmStore.getState().reorderTask(taskId, targetStatus, newSortOrder);
  };

  const handleDelete = async (taskId: string) => {
    await usePmStore.getState().deleteTask(taskId);
  };

  const handleExportCsv = useCallback(() => {
    const projectTasks = tasks.filter((t) => t.projectId === projectId);
    if (projectTasks.length === 0) return;

    const headers = ['Title', 'Status', 'Priority', 'Labels', 'Created'];
    const rows = projectTasks.map((t: PmTask) => [
      `"${t.title.replace(/"/g, '""')}"`,
      t.status,
      t.priority,
      `"${t.labels.join(', ')}"`,
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

    RuntimeScope.track('export_csv', {
      projectId,
      taskCount: projectTasks.length,
    });
  }, [tasks, projectId]);

  const totalTasks = tasks.filter((t) => t.projectId === projectId).length;

  if (!tasksLoading && totalTasks === 0) {
    return (
      <div className="flex-1 flex flex-col">
        {/* New task form */}
        <div className="p-4 border-b border-border-muted">
          <div className="flex items-center gap-2">
            <input
              type="text"
              placeholder="New task title..."
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
              className="flex-1 h-9 px-3 rounded-md bg-bg-elevated border border-border-default text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-brand"
            />
            <select
              value={newPriority}
              onChange={(e) => setNewPriority(e.target.value as TaskPriority)}
              className="h-9 px-2 rounded-md bg-bg-elevated border border-border-default text-sm text-text-primary focus:outline-none focus:border-brand"
            >
              {PRIORITY_OPTIONS.map((p) => (
                <option key={p} value={p}>
                  {p.charAt(0).toUpperCase() + p.slice(1)}
                </option>
              ))}
            </select>
            <Button variant="primary" size="sm" onClick={handleCreate}>
              <Plus size={14} />
              Add
            </Button>
            {totalTasks > 0 && (
              <Button variant="ghost" size="sm" onClick={handleExportCsv} title="Export tasks as CSV">
                <Download size={14} />
              </Button>
            )}
          </div>
        </div>
        <EmptyState
          icon={<GripVertical size={32} />}
          title="No tasks yet"
          description="Create your first task to get started with the Kanban board."
        />
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
      {/* New task form */}
      <div className="p-4 border-b border-border-muted">
        <div className="flex items-center gap-2">
          <input
            type="text"
            placeholder="New task title..."
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
            className="flex-1 h-9 px-3 rounded-md bg-bg-elevated border border-border-default text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-brand"
          />
          <select
            value={newPriority}
            onChange={(e) => setNewPriority(e.target.value as TaskPriority)}
            className="h-9 px-2 rounded-md bg-bg-elevated border border-border-default text-sm text-text-primary focus:outline-none focus:border-brand"
          >
            {PRIORITY_OPTIONS.map((p) => (
              <option key={p} value={p}>
                {p.charAt(0).toUpperCase() + p.slice(1)}
              </option>
            ))}
          </select>
          <Button variant="primary" size="sm" onClick={handleCreate}>
            <Plus size={14} />
            Add
          </Button>
        </div>
      </div>

      {/* Kanban columns */}
      <div className="flex-1 flex gap-4 p-4 overflow-x-auto">
        {COLUMNS.map((col) => {
          const columnTasks = tasksByStatus(col.status);
          const isDropTarget = dragOverColumn === col.status;

          return (
            <div
              key={col.status}
              onDragOver={(e) => handleDragOver(e, col.status)}
              onDragLeave={handleDragLeave}
              onDrop={(e) => handleDrop(e, col.status)}
              className={cn(
                'flex-1 min-w-[280px] bg-bg-base rounded-lg border p-3 flex flex-col',
                isDropTarget
                  ? 'border-brand border-dashed'
                  : 'border-border-muted'
              )}
            >
              {/* Column header */}
              <div className="flex items-center gap-2 mb-3">
                <span className="text-sm font-semibold text-text-primary">
                  {col.label}
                </span>
                <Badge size="sm">{columnTasks.length}</Badge>
              </div>

              {/* Task cards */}
              <div className="flex-1 overflow-y-auto space-y-2">
                {columnTasks.map((task) => (
                  <div
                    key={task.id}
                    draggable
                    onDragStart={(e) => handleDragStart(e, task.id)}
                    className="bg-bg-elevated rounded-md border border-border-default p-3 cursor-grab active:cursor-grabbing"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <GripVertical
                          size={14}
                          className="shrink-0 text-text-muted"
                        />
                        <span className="text-sm font-medium text-text-primary truncate">
                          {task.title}
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={() => handleDelete(task.id)}
                        className="shrink-0 p-1 rounded text-text-muted hover:text-red hover:bg-red-muted transition-colors"
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>

                    <div className="flex items-center gap-1.5 mt-2 flex-wrap">
                      <Badge variant={PRIORITY_VARIANT[task.priority]} size="sm">
                        {task.priority}
                      </Badge>
                      {task.labels.map((label) => (
                        <Badge key={label} size="sm">
                          {label}
                        </Badge>
                      ))}
                      {task.source !== 'manual' && (
                        <Badge variant="purple" size="sm">
                          {task.source}
                        </Badge>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
