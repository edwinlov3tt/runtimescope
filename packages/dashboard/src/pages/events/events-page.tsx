import { useState, useEffect, useMemo, useCallback } from 'react';
import { fetchCustomEvents } from '@/lib/api';
import { Badge, Button, DataTable, DetailPanel, EmptyState } from '@/components/ui';
import { RefreshCw, Zap, ArrowRight, ChevronDown, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/cn';
import type { CustomEvent } from '@/lib/runtime-types';

// ---------------------------------------------------------------------------
// Event Catalog (unique event names with counts)
// ---------------------------------------------------------------------------

interface CatalogEntry {
  name: string;
  count: number;
  lastSeen: number;
  sampleProperties?: Record<string, unknown>;
}

function buildCatalog(events: CustomEvent[]): CatalogEntry[] {
  const map = new Map<string, CatalogEntry>();
  for (const e of events) {
    const entry = map.get(e.name);
    if (!entry) {
      map.set(e.name, { name: e.name, count: 1, lastSeen: e.timestamp, sampleProperties: e.properties });
    } else {
      entry.count++;
      if (e.timestamp > entry.lastSeen) {
        entry.lastSeen = e.timestamp;
        entry.sampleProperties = e.properties;
      }
    }
  }
  return Array.from(map.values()).sort((a, b) => b.lastSeen - a.lastSeen);
}

// ---------------------------------------------------------------------------
// Funnel visualization
// ---------------------------------------------------------------------------

interface FunnelStep {
  name: string;
  count: number;
  conversionRate: number | null;
}

function buildFunnel(events: CustomEvent[], steps: string[]): FunnelStep[] {
  // Group events by session
  const bySession = new Map<string, CustomEvent[]>();
  for (const e of events) {
    if (!bySession.has(e.sessionId)) bySession.set(e.sessionId, []);
    bySession.get(e.sessionId)!.push(e);
  }
  // Sort each session's events chronologically
  for (const evts of bySession.values()) evts.sort((a, b) => a.timestamp - b.timestamp);

  const results: FunnelStep[] = steps.map((name) => ({ name, count: 0, conversionRate: null }));

  for (const sessionEvents of bySession.values()) {
    let prevTime: number | null = null;
    for (let i = 0; i < steps.length; i++) {
      const occ = sessionEvents.find((e) => e.name === steps[i] && (prevTime === null || e.timestamp >= prevTime));
      if (!occ) break;
      results[i].count++;
      prevTime = occ.timestamp;
    }
  }

  // Compute conversion rates
  for (let i = 0; i < results.length; i++) {
    if (i === 0) {
      results[i].conversionRate = bySession.size > 0 ? (results[i].count / bySession.size) * 100 : 0;
    } else {
      results[i].conversionRate = results[i - 1].count > 0 ? (results[i].count / results[i - 1].count) * 100 : 0;
    }
  }

  return results;
}

function FunnelBar({ step, maxCount, index }: { step: FunnelStep; maxCount: number; index: number }) {
  const width = maxCount > 0 ? (step.count / maxCount) * 100 : 0;
  const isDropoff = step.conversionRate !== null && step.conversionRate < 50;

  return (
    <div className="flex items-center gap-3">
      <span className="text-xs text-text-muted w-5 text-right">{index + 1}.</span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between mb-1">
          <span className="text-xs font-medium text-text-primary truncate">{step.name}</span>
          <div className="flex items-center gap-2">
            <span className="text-xs text-text-muted">{step.count} session{step.count !== 1 ? 's' : ''}</span>
            {step.conversionRate !== null && index > 0 && (
              <Badge variant={isDropoff ? 'red' : 'green'} size="sm">
                {step.conversionRate.toFixed(0)}%
              </Badge>
            )}
          </div>
        </div>
        <div className="h-2 bg-bg-surface rounded-full overflow-hidden">
          <div
            className={cn('h-full rounded-full transition-all duration-500', isDropoff ? 'bg-red' : 'bg-accent')}
            style={{ width: `${width}%` }}
          />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Flow Builder
// ---------------------------------------------------------------------------

function FlowBuilder({
  catalog,
  steps,
  setSteps,
}: {
  catalog: CatalogEntry[];
  steps: string[];
  setSteps: (s: string[]) => void;
}) {
  const [open, setOpen] = useState(steps.length > 0);

  const addStep = (name: string) => {
    if (!steps.includes(name)) setSteps([...steps, name]);
  };
  const removeStep = (index: number) => setSteps(steps.filter((_, i) => i !== index));

  return (
    <div className="border border-border-default rounded-lg overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 px-3 py-2 text-xs font-medium text-text-secondary hover:bg-bg-hover transition-colors cursor-pointer"
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        Flow Builder
        {steps.length > 0 && <Badge variant="default" size="sm">{steps.length} steps</Badge>}
      </button>

      {open && (
        <div className="px-3 py-2 border-t border-border-default space-y-2">
          {/* Current steps */}
          {steps.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              {steps.map((s, i) => (
                <div key={i} className="flex items-center gap-1">
                  {i > 0 && <ArrowRight size={10} className="text-text-muted" />}
                  <button
                    type="button"
                    onClick={() => removeStep(i)}
                    className="px-2 py-0.5 rounded text-xs font-medium bg-accent/15 text-accent hover:bg-red/15 hover:text-red transition-colors cursor-pointer"
                    title="Remove step"
                  >
                    {s}
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Available events to add */}
          <div className="flex flex-wrap gap-1">
            {catalog
              .filter((c) => !steps.includes(c.name))
              .map((c) => (
                <button
                  key={c.name}
                  type="button"
                  onClick={() => addStep(c.name)}
                  className="px-2 py-0.5 rounded text-xs bg-bg-surface text-text-muted hover:bg-bg-hover hover:text-text-primary transition-colors cursor-pointer"
                >
                  + {c.name} ({c.count})
                </button>
              ))}
          </div>

          {steps.length > 0 && (
            <button
              type="button"
              onClick={() => setSteps([])}
              className="text-xs text-text-muted hover:text-red transition-colors cursor-pointer"
            >
              Clear flow
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Events Page
// ---------------------------------------------------------------------------

export function EventsPage() {
  const [events, setEvents] = useState<CustomEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [nameFilter, setNameFilter] = useState<string | null>(null);
  const [funnelSteps, setFunnelSteps] = useState<string[]>([]);

  const loadEvents = useCallback(async () => {
    setLoading(true);
    const data = await fetchCustomEvents({ since_seconds: 3600 });
    setEvents(data ?? []);
    setLoading(false);
  }, []);

  useEffect(() => { loadEvents(); }, [loadEvents]);

  // Auto-refresh every 5s
  useEffect(() => {
    const interval = setInterval(async () => {
      const data = await fetchCustomEvents({ since_seconds: 3600 });
      if (data) setEvents(data);
    }, 5000);
    return () => clearInterval(interval);
  }, []);

  const catalog = useMemo(() => buildCatalog(events), [events]);
  const filteredEvents = useMemo(
    () => nameFilter ? events.filter((e) => e.name === nameFilter) : events,
    [events, nameFilter]
  );
  const funnel = useMemo(
    () => funnelSteps.length >= 2 ? buildFunnel(events, funnelSteps) : null,
    [events, funnelSteps]
  );
  const maxFunnelCount = funnel ? Math.max(...funnel.map((s) => s.count), 1) : 1;

  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const selectedEvent = selectedIndex !== null ? filteredEvents[selectedIndex] ?? null : null;

  const columns = useMemo(() => [
    {
      key: 'timestamp',
      header: 'Time',
      width: '140px',
      render: (row: Record<string, unknown>) => (
        <span className="font-mono text-text-muted">
          {new Date(row.timestamp as number).toLocaleTimeString()}
        </span>
      ),
    },
    {
      key: 'name',
      header: 'Event',
      render: (row: Record<string, unknown>) => (
        <span className="font-medium text-accent">{row.name as string}</span>
      ),
    },
    {
      key: 'properties',
      header: 'Properties',
      render: (row: Record<string, unknown>) => (
        <span className="text-text-muted font-mono text-xs truncate block max-w-[400px]">
          {row.properties ? JSON.stringify(row.properties) : '-'}
        </span>
      ),
    },
    {
      key: 'sessionId',
      header: 'Session',
      width: '100px',
      render: (row: Record<string, unknown>) => (
        <span className="font-mono text-text-muted">{(row.sessionId as string).slice(0, 8)}</span>
      ),
    },
  ], []);

  if (events.length === 0 && !loading) {
    return (
      <EmptyState
        icon={<Zap size={32} />}
        title="No Custom Events"
        description="Use RuntimeScope.track('event_name', { ...properties }) in your app to track business events. Events appear here with correlated telemetry."
      />
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 border-b border-border-default space-y-3">
        <div className="flex items-center gap-3">
          <h2 className="text-sm font-semibold text-text-primary">Custom Events</h2>
          <Badge variant="default" size="sm">{events.length} events</Badge>
          <Badge variant="default" size="sm">{catalog.length} types</Badge>
          <div className="flex-1" />
          <Button size="sm" variant="ghost" onClick={loadEvents} disabled={loading}>
            <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
            Refresh
          </Button>
        </div>

        {/* Event name filter pills */}
        <div className="flex flex-wrap gap-1.5">
          <button
            type="button"
            onClick={() => setNameFilter(null)}
            className={cn(
              'px-2 py-0.5 rounded text-xs font-medium transition-colors cursor-pointer',
              !nameFilter ? 'bg-accent/15 text-accent' : 'bg-bg-surface text-text-muted hover:bg-bg-hover'
            )}
          >
            All ({events.length})
          </button>
          {catalog.map((c) => (
            <button
              key={c.name}
              type="button"
              onClick={() => setNameFilter(nameFilter === c.name ? null : c.name)}
              className={cn(
                'px-2 py-0.5 rounded text-xs font-medium transition-colors cursor-pointer',
                nameFilter === c.name ? 'bg-accent/15 text-accent' : 'bg-bg-surface text-text-muted hover:bg-bg-hover'
              )}
            >
              {c.name} ({c.count})
            </button>
          ))}
        </div>

        {/* Flow builder */}
        <FlowBuilder catalog={catalog} steps={funnelSteps} setSteps={setFunnelSteps} />
      </div>

      <div className="flex-1 flex min-h-0 overflow-hidden">
        {/* Left: funnel + event table */}
        <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
          {/* Funnel visualization */}
          {funnel && (
            <div className="px-4 py-3 border-b border-border-default space-y-2">
              <div className="text-xs font-medium text-text-secondary mb-2">Flow Funnel</div>
              {funnel.map((step, i) => (
                <FunnelBar key={step.name} step={step} maxCount={maxFunnelCount} index={i} />
              ))}
            </div>
          )}

          {/* Events table */}
          <div className="flex-1 min-h-0 overflow-auto">
            <DataTable
              columns={columns}
              data={filteredEvents as unknown as Record<string, unknown>[]}
              onRowClick={(_row, index) => setSelectedIndex(index)}
              selectedIndex={selectedIndex ?? undefined}
              emptyMessage="No events match the current filter"
            />
          </div>
        </div>

        {/* Right: detail panel */}
        <DetailPanel
          open={selectedEvent !== null}
          title={selectedEvent?.name ?? ''}
          onClose={() => setSelectedIndex(null)}
        >
            {selectedEvent && (
              <div className="space-y-4 p-4">
                <div>
                  <div className="text-xs text-text-muted mb-1">Time</div>
                  <div className="text-sm font-mono">{new Date(selectedEvent.timestamp).toLocaleString()}</div>
                </div>
                <div>
                  <div className="text-xs text-text-muted mb-1">Session</div>
                  <div className="text-sm font-mono">{selectedEvent.sessionId}</div>
                </div>
                <div>
                  <div className="text-xs text-text-muted mb-1">Event ID</div>
                  <div className="text-sm font-mono">{selectedEvent.eventId}</div>
                </div>
                {selectedEvent.properties && Object.keys(selectedEvent.properties).length > 0 && (
                  <div>
                    <div className="text-xs text-text-muted mb-1">Properties</div>
                    <pre className="text-xs font-mono bg-bg-surface rounded p-2 overflow-auto max-h-64 whitespace-pre-wrap">
                      {JSON.stringify(selectedEvent.properties, null, 2)}
                    </pre>
                  </div>
                )}
              </div>
            )}
          </DetailPanel>
      </div>
    </div>
  );
}
