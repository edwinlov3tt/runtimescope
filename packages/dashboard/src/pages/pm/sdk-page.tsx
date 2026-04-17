import { useState, useCallback } from 'react';
import { useAppStore } from '@/stores/use-app-store';
import { usePmStore } from '@/stores/use-pm-store';
import { findRuntimeProjects } from '@/lib/api';
import { Badge, Button } from '@/components/ui';
import { StatusDot } from '@/components/ui/status-dot';
import { EmptyState } from '@/components/ui/empty-state';
import { Plug, Plus, X, Wifi, WifiOff } from 'lucide-react';
import { cn } from '@/lib/cn';
import type { PmProject } from '@/lib/pm-types';
import type { ProjectInfo } from '@/lib/api';

// ---------------------------------------------------------------------------
// SDK Installation Card
// ---------------------------------------------------------------------------

function SdkCard({
  appName,
  runtimeProject,
  onRemove,
}: {
  appName: string;
  runtimeProject: ProjectInfo | undefined;
  onRemove: (app: string) => void;
}) {
  const isConnected = runtimeProject?.isConnected ?? false;

  return (
    <div className={cn(
      'border rounded-lg p-4 transition-colors',
      isConnected
        ? 'border-green-500/30 bg-green-500/5'
        : 'border-border-muted bg-bg-surface',
    )}>
      <div className="flex items-center gap-3">
        <StatusDot
          color={isConnected ? 'green' : 'gray'}
          size="md"
          pulse={isConnected}
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-mono text-sm font-medium text-text-primary truncate">
              {appName}
            </span>
            <Badge variant={isConnected ? 'green' : 'default'} size="sm">
              {isConnected ? 'Connected' : 'Disconnected'}
            </Badge>
          </div>
          {runtimeProject && (
            <div className="flex items-center gap-3 mt-1 text-[11px] text-text-muted">
              {runtimeProject.sessions.length > 0 && (
                <span>{runtimeProject.sessions.length} session{runtimeProject.sessions.length !== 1 ? 's' : ''}</span>
              )}
              <span>{runtimeProject.eventCount.toLocaleString()} events</span>
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={() => onRemove(appName)}
          className="p-1.5 rounded-md text-text-muted hover:text-red hover:bg-red-500/10 transition-colors cursor-pointer"
          title="Remove SDK link"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export function SdkPage({ project }: { project: PmProject }) {
  const runtimeProjects = useAppStore((s) => s.projects);
  const [newApp, setNewApp] = useState('');

  const apps = project.runtimeApps ?? (project.runtimescopeProject ? [project.runtimescopeProject] : []);
  const matchedRps = findRuntimeProjects(runtimeProjects, {
    runtimescopeProject: project.runtimescopeProject,
    runtimeApps: project.runtimeApps,
    name: project.name,
  });

  const connectedCount = matchedRps.filter((r) => r.isConnected).length;

  // Unlinked runtime projects available for quick-add
  const unlinkedRps = runtimeProjects.filter(
    (r) => !apps.some((a) => a.toLowerCase() === r.appName.toLowerCase()),
  );

  const handleAdd = useCallback((appName: string) => {
    const trimmed = appName.trim();
    if (!trimmed || apps.some((a) => a.toLowerCase() === trimmed.toLowerCase())) return;
    const updated = [...apps, trimmed];
    usePmStore.getState().updateProject(project.id, { runtimeApps: updated });
    setNewApp('');
  }, [apps, project.id]);

  const handleRemove = useCallback((appName: string) => {
    const updated = apps.filter((a) => a !== appName);
    usePmStore.getState().updateProject(project.id, { runtimeApps: updated.length ? updated : undefined });
  }, [apps, project.id]);

  if (apps.length === 0 && unlinkedRps.length === 0) {
    return (
      <EmptyState
        icon={<Plug size={40} strokeWidth={1.25} />}
        title="No SDK Installations"
        description="Connect the RuntimeScope SDK in your app to see live telemetry. SDK instances will be automatically linked when they connect."
      />
    );
  }

  return (
    <div className="flex-1 overflow-y-auto p-5 space-y-5">
      {/* Summary */}
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2">
          {connectedCount > 0 ? (
            <Wifi size={16} className="text-green" />
          ) : (
            <WifiOff size={16} className="text-text-muted" />
          )}
          <span className="text-sm font-medium text-text-primary">
            {connectedCount} of {apps.length} connected
          </span>
        </div>
      </div>

      {/* SDK cards */}
      <div className="space-y-2">
        {apps.map((app) => {
          const rp = matchedRps.find((r) => r.appName.toLowerCase() === app.toLowerCase());
          return (
            <SdkCard
              key={app}
              appName={app}
              runtimeProject={rp}
              onRemove={handleRemove}
            />
          );
        })}
      </div>

      {/* Quick-add from discovered runtime projects */}
      {unlinkedRps.length > 0 && (
        <div>
          <p className="text-[11px] text-text-muted uppercase tracking-wider font-medium mb-2">
            Available SDK Instances
          </p>
          <div className="space-y-1">
            {unlinkedRps.map((rp) => (
              <button
                key={rp.appName}
                type="button"
                onClick={() => handleAdd(rp.appName)}
                className="w-full flex items-center gap-3 px-3 py-2 rounded-lg border border-dashed border-border-muted hover:border-accent/40 hover:bg-accent-muted/30 transition-colors cursor-pointer"
              >
                <Plus size={14} className="text-text-tertiary" />
                <span className="font-mono text-xs text-text-secondary">{rp.appName}</span>
                {rp.isConnected && (
                  <Badge variant="green" size="sm">Live</Badge>
                )}
                <span className="ml-auto text-[10px] text-text-muted">
                  {rp.eventCount} events
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Manual add */}
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={newApp}
          onChange={(e) => setNewApp(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleAdd(newApp)}
          placeholder="Add SDK app name manually..."
          className="flex-1 h-8 px-3 rounded-md border border-border-muted bg-bg-surface text-sm text-text-primary placeholder:text-text-muted outline-none focus:border-accent/40 font-mono"
        />
        {newApp.trim() && (
          <Button size="sm" onClick={() => handleAdd(newApp)}>
            Add
          </Button>
        )}
      </div>
    </div>
  );
}
