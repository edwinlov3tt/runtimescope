import { useState, useEffect } from 'react';
import { usePmStore } from '@/stores/use-pm-store';
import { Tabs, Button, EmptyState } from '@/components/ui';
import { Save, FileText } from 'lucide-react';
import { cn } from '@/lib/cn';

type Scope = 'global' | 'project' | 'local';

const SCOPE_TABS = [
  { id: 'local', label: 'Local' },
  { id: 'project', label: 'Project' },
  { id: 'global', label: 'Global' },
];

const SCOPE_DESCRIPTIONS: Record<Scope, string> = {
  global: '~/.claude/CLAUDE.md — Applies to all projects',
  project: '~/.claude/projects/<key>/CLAUDE.md — Project-specific rules',
  local: '<project-path>/CLAUDE.md — Local, gitignored rules',
};

export function RulesPage({ projectId }: { projectId: string }) {
  const rules = usePmStore((s) => s.rules);
  const rulesLoading = usePmStore((s) => s.rulesLoading);

  const [activeScope, setActiveScope] = useState<Scope>('local');
  const [globalContent, setGlobalContent] = useState('');
  const [projectContent, setProjectContent] = useState('');
  const [localContent, setLocalContent] = useState('');
  const [globalDirty, setGlobalDirty] = useState(false);
  const [projectDirty, setProjectDirty] = useState(false);
  const [localDirty, setLocalDirty] = useState(false);

  useEffect(() => {
    usePmStore.getState().fetchRules(projectId);
  }, [projectId]);

  useEffect(() => {
    if (!rules) return;
    setGlobalContent(rules.global.content);
    setProjectContent(rules.project.content);
    setLocalContent(rules.local.content);
    setGlobalDirty(false);
    setProjectDirty(false);
    setLocalDirty(false);
  }, [rules]);

  const contentMap: Record<Scope, string> = {
    global: globalContent,
    project: projectContent,
    local: localContent,
  };

  const setContentMap: Record<Scope, (v: string) => void> = {
    global: setGlobalContent,
    project: setProjectContent,
    local: setLocalContent,
  };

  const dirtyMap: Record<Scope, boolean> = {
    global: globalDirty,
    project: projectDirty,
    local: localDirty,
  };

  const setDirtyMap: Record<Scope, (v: boolean) => void> = {
    global: setGlobalDirty,
    project: setProjectDirty,
    local: setLocalDirty,
  };

  const currentContent = contentMap[activeScope];
  const currentDirty = dirtyMap[activeScope];
  const currentFile = rules?.[activeScope];

  function handleContentChange(value: string) {
    setContentMap[activeScope](value);
    setDirtyMap[activeScope](true);
  }

  async function handleSave() {
    await usePmStore.getState().saveRule(projectId, activeScope, currentContent);
    setDirtyMap[activeScope](false);
  }

  if (rulesLoading && !rules) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-sm text-text-muted">Loading rules...</p>
      </div>
    );
  }

  if (!rules) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <EmptyState
          icon={<FileText size={32} />}
          title="No rules available"
          description="Could not load CLAUDE.md files for this project."
        />
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
      <Tabs
        tabs={SCOPE_TABS}
        activeTab={activeScope}
        onTabChange={(id) => setActiveScope(id as Scope)}
      />

      <div className="px-4 pt-3 space-y-1 shrink-0">
        <p className="text-xs text-text-muted">
          {SCOPE_DESCRIPTIONS[activeScope]}
        </p>
        <p className="font-mono text-xs text-text-tertiary">
          {currentFile?.path}
        </p>
      </div>

      <textarea
        className="w-full flex-1 bg-transparent text-text-primary text-sm font-mono p-4 resize-none outline-none border-t border-border-muted mt-3"
        value={currentContent}
        onChange={(e) => handleContentChange(e.target.value)}
        spellCheck={false}
      />

      <div className="flex items-center justify-between px-4 py-3 border-t border-border-muted">
        <span
          className={cn(
            'text-xs',
            currentFile?.exists ? 'text-text-secondary' : 'text-text-muted'
          )}
        >
          {currentFile?.exists ? 'File exists' : 'File not found'}
        </span>

        <Button
          variant="primary"
          size="sm"
          disabled={!currentDirty}
          onClick={handleSave}
        >
          <Save size={14} />
          Save
        </Button>
      </div>
    </div>
  );
}
