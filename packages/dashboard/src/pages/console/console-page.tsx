import { useState, useMemo, useCallback, memo } from 'react';
import { Topbar } from '@/components/layout/topbar';
import { StackTrace, JsonViewer } from '@/components/ui';
import { SearchInput } from '@/components/ui/input';
import { ExportButton } from '@/components/ui/export-button';
import { ListSkeleton } from '@/components/ui/skeleton';
import { useDataStore } from '@/stores/use-data-store';
import { useConnected } from '@/hooks/use-connected';
import { formatTimestamp } from '@/lib/format';
import { cn } from '@/lib/cn';
import { AlertCircle, AlertTriangle, Info, Bug, Terminal, ChevronRight } from 'lucide-react';
import type { ConsoleEvent } from '@/lib/runtime-types';

const LEVEL_CONFIG: Record<string, { icon: typeof AlertCircle; color: string; badge: string; dotColor: string; rowTint: string }> = {
  error: { icon: AlertCircle, color: 'text-red', badge: 'red', dotColor: 'bg-red', rowTint: 'bg-red-muted/30' },
  warn:  { icon: AlertTriangle, color: 'text-amber', badge: 'amber', dotColor: 'bg-amber', rowTint: 'bg-amber-muted/20' },
  info:  { icon: Info, color: 'text-blue', badge: 'blue', dotColor: 'bg-blue', rowTint: '' },
  log:   { icon: Terminal, color: 'text-text-secondary', badge: 'default', dotColor: 'bg-text-tertiary', rowTint: '' },
  debug: { icon: Bug, color: 'text-purple', badge: 'purple', dotColor: 'bg-purple', rowTint: '' },
  trace: { icon: Terminal, color: 'text-cyan', badge: 'cyan', dotColor: 'bg-cyan', rowTint: '' },
};

const LEVELS = ['all', 'error', 'warn', 'info', 'log', 'debug'] as const;
const RENDER_CAP = 200;

// ---------------------------------------------------------------------------
// Console Row
// ---------------------------------------------------------------------------

const ConsoleRow = memo(function ConsoleRow({
  entry,
  isExpanded,
  onToggle,
}: {
  entry: ConsoleEvent;
  isExpanded: boolean;
  onToggle: (id: string) => void;
}) {
  const config = LEVEL_CONFIG[entry.level] || LEVEL_CONFIG.log;
  const Icon = config.icon;
  const hasDetails = (entry.args && entry.args.length > 0) || entry.stackTrace;

  return (
    <div className={cn('border-b border-border-muted', config.rowTint)}>
      <div
        onClick={() => hasDetails && onToggle(entry.eventId)}
        className={cn(
          'flex items-start gap-0 transition-colors',
          hasDetails && 'cursor-pointer hover:bg-bg-hover',
          isExpanded && 'bg-bg-hover',
        )}
      >
        {/* Timestamp */}
        <span className="w-[90px] shrink-0 px-3 py-2 text-[11px] font-mono text-text-disabled whitespace-nowrap">
          {formatTimestamp(entry.timestamp)}
        </span>

        {/* Level badge */}
        <span className="w-[64px] shrink-0 py-2 px-2 flex items-center gap-1.5">
          <span className={cn(
            'text-[10px] font-bold uppercase px-1.5 py-px rounded',
            entry.level === 'error' ? 'bg-red-muted text-red' :
            entry.level === 'warn'  ? 'bg-amber-muted text-amber' :
            entry.level === 'info'  ? 'bg-blue-muted text-blue' :
            entry.level === 'debug' ? 'bg-purple-muted text-purple' :
            'bg-bg-overlay text-text-tertiary',
          )}>
            {entry.level.toUpperCase()}
          </span>
        </span>

        {/* Message */}
        <span className={cn(
          'flex-1 py-2 pr-3 font-mono text-[12px] leading-relaxed whitespace-pre-wrap break-words min-w-0',
          entry.level === 'error' ? 'text-red' :
          entry.level === 'warn' ? 'text-amber' :
          'text-text-secondary',
        )}>
          {entry.message}
        </span>

        {/* Source file */}
        {entry.sourceFile && (
          <span className="w-[160px] shrink-0 py-2 pr-3 text-[11px] text-right text-accent font-mono truncate">
            {entry.sourceFile}
          </span>
        )}

        {/* Expand chevron */}
        {hasDetails && (
          <span className="shrink-0 py-2 pr-3 flex items-center text-text-disabled">
            <ChevronRight size={12} className={cn('transition-transform', isExpanded && 'rotate-90')} />
          </span>
        )}
      </div>

      {/* Expanded detail */}
      {isExpanded && (
        <div className="bg-bg-elevated border-b border-border-muted">
          <div className="py-3 px-4 ml-[154px] space-y-3">
            {entry.args && entry.args.length > 0 && (
              <div>
                <p className="text-[10px] font-semibold text-text-muted uppercase tracking-wider mb-1.5">Arguments</p>
                <div className="bg-bg-base rounded-md p-3 border border-border-muted">
                  <JsonViewer data={entry.args.length === 1 ? entry.args[0] : entry.args} defaultExpanded={true} />
                </div>
              </div>
            )}
            {entry.stackTrace && (
              <div>
                <p className="text-[10px] font-semibold text-text-muted uppercase tracking-wider mb-1.5">Stack Trace</p>
                <div className="bg-bg-base rounded-md py-2 border border-border-muted">
                  <StackTrace trace={entry.stackTrace} />
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
});

// ---------------------------------------------------------------------------
// Console Page
// ---------------------------------------------------------------------------

export function ConsolePage() {
  const [activeLevel, setActiveLevel] = useState<string>('all');
  const [search, setSearch] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const connected = useConnected();
  const liveConsole = useDataStore((s) => s.console);
  const initialLoadDone = useDataStore((s) => s.initialLoadDone);
  const allData = liveConsole;

  const levelCounts = useMemo(() => {
    const counts: Record<string, number> = { all: allData.length };
    for (const e of allData) {
      counts[e.level] = (counts[e.level] || 0) + 1;
    }
    return counts;
  }, [allData]);

  const filtered = useMemo(() => {
    let data = allData;
    if (activeLevel !== 'all') data = data.filter((e) => e.level === activeLevel);
    if (search) {
      const q = search.toLowerCase();
      data = data.filter((e) => e.message.toLowerCase().includes(q) || e.sourceFile?.toLowerCase().includes(q));
    }
    return data;
  }, [activeLevel, search, allData]);

  const rendered = useMemo(
    () => (showAll || filtered.length <= RENDER_CAP ? filtered : filtered.slice(0, RENDER_CAP)),
    [filtered, showAll],
  );
  const isCapped = !showAll && filtered.length > RENDER_CAP;

  const handleToggle = useCallback((id: string) => {
    setExpandedId((prev) => (prev === id ? null : id));
  }, []);

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
      {/* Toolbar */}
      <div className="border-b border-border-default px-5 py-2.5 flex items-center gap-3 shrink-0">
        {/* Level pill group */}
        <div className="flex items-center gap-0.5 bg-bg-surface border border-border-default rounded-md p-0.5">
          {LEVELS.map((level) => {
            const config = level === 'all' ? null : LEVEL_CONFIG[level];
            const isActive = activeLevel === level;
            return (
              <button
                key={level}
                onClick={() => setActiveLevel(level)}
                className={cn(
                  'h-[26px] px-2.5 rounded text-[12px] font-medium transition-colors cursor-pointer flex items-center gap-1.5 whitespace-nowrap',
                  isActive
                    ? 'bg-bg-overlay text-text-primary'
                    : 'text-text-muted hover:text-text-secondary hover:bg-bg-hover',
                )}
              >
                {config && <span className={cn('w-1.5 h-1.5 rounded-full shrink-0', config.dotColor)} />}
                <span className="capitalize">{level}</span>
                <span className={cn('text-[10px] font-mono tabular-nums', isActive ? 'text-text-secondary' : 'text-text-disabled')}>
                  {levelCounts[level] || 0}
                </span>
              </button>
            );
          })}
        </div>

        {/* Search + export */}
        <div className="flex items-center gap-2 ml-auto">
          <div className="w-56">
            <SearchInput
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Filter by message or source..."
            />
          </div>
          <ExportButton data={filtered as unknown as Record<string, unknown>[]} filename="console-events" />
        </div>
      </div>

      {/* Log stream */}
      <div className="flex-1 flex flex-col min-h-0">
        <div className="flex-1 overflow-y-auto border border-border-strong rounded-lg mx-5 mt-4 mb-0 overflow-hidden">
          {!initialLoadDone && allData.length === 0 ? (
            <ListSkeleton rows={12} />
          ) : (
            <>
              {rendered.map((entry, i) => (
                <ConsoleRow
                  key={`${entry.eventId}-${i}`}
                  entry={entry}
                  isExpanded={expandedId === entry.eventId}
                  onToggle={handleToggle}
                />
              ))}
              {isCapped && (
                <div className="px-5 py-3 text-center">
                  <button
                    onClick={() => setShowAll(true)}
                    className="text-xs text-text-tertiary hover:text-text-secondary transition-colors cursor-pointer"
                  >
                    Showing {RENDER_CAP} of {filtered.length} entries — click to show all
                  </button>
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-5 py-2 text-[11px] text-text-muted shrink-0 mx-5">
          <span>Showing {rendered.length} entries</span>
          <div className="flex items-center gap-3">
            {(levelCounts.error ?? 0) > 0 && <span className="flex items-center gap-1"><span className="w-1 h-1 rounded-full bg-red" /> {levelCounts.error} Error</span>}
            {(levelCounts.warn ?? 0) > 0 && <span className="flex items-center gap-1"><span className="w-1 h-1 rounded-full bg-amber" /> {levelCounts.warn} Warning</span>}
            {(levelCounts.info ?? 0) > 0 && <span className="flex items-center gap-1"><span className="w-1 h-1 rounded-full bg-blue" /> {levelCounts.info} Info</span>}
            {(levelCounts.log ?? 0) > 0 && <span className="flex items-center gap-1"><span className="w-1 h-1 rounded-full bg-text-tertiary" /> {levelCounts.log} Log</span>}
            {(levelCounts.debug ?? 0) > 0 && <span className="flex items-center gap-1"><span className="w-1 h-1 rounded-full bg-purple" /> {levelCounts.debug} Debug</span>}
          </div>
        </div>
      </div>
    </div>
  );
}
