import { useState, useMemo } from 'react';
import { Topbar } from '@/components/layout/topbar';
import { Badge, StackTrace, JsonViewer } from '@/components/ui';
import { SearchInput } from '@/components/ui/input';
import { MOCK_CONSOLE } from '@/mock/console';
import { useDataStore } from '@/stores/use-data-store';
import { useConnected } from '@/hooks/use-connected';
import { formatTimestamp } from '@/lib/format';
import { cn } from '@/lib/cn';
import { AlertCircle, AlertTriangle, Info, Bug, Terminal, ChevronRight } from 'lucide-react';
import type { ConsoleEvent } from '@/mock/types';

const LEVEL_CONFIG: Record<string, { icon: typeof AlertCircle; color: string; badge: string }> = {
  error: { icon: AlertCircle, color: 'text-red', badge: 'red' },
  warn: { icon: AlertTriangle, color: 'text-amber', badge: 'amber' },
  info: { icon: Info, color: 'text-blue', badge: 'blue' },
  log: { icon: Terminal, color: 'text-text-secondary', badge: 'default' },
  debug: { icon: Bug, color: 'text-purple', badge: 'purple' },
  trace: { icon: Terminal, color: 'text-cyan', badge: 'cyan' },
};

const LEVELS = ['all', 'error', 'warn', 'info', 'log', 'debug'] as const;

export function ConsolePage() {
  const [activeLevel, setActiveLevel] = useState<string>('all');
  const [search, setSearch] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const connected = useConnected();
  const source = useDataStore((s) => s.source);
  const liveConsole = useDataStore((s) => s.console);
  const allData = source === 'live' ? liveConsole : MOCK_CONSOLE;

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

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <Topbar title="Console" connected={connected} />

      {/* Level filters + search */}
      <div className="border-b border-border-default px-5 py-2.5 flex items-center gap-3">
        <div className="flex items-center gap-1">
          {LEVELS.map((level) => {
            const config = level === 'all' ? null : LEVEL_CONFIG[level];
            const isActive = activeLevel === level;
            return (
              <button
                key={level}
                onClick={() => setActiveLevel(level)}
                className={cn(
                  'h-7 px-2.5 rounded-md text-[12px] font-medium transition-colors cursor-pointer flex items-center gap-1.5',
                  isActive
                    ? 'bg-bg-elevated text-text-primary'
                    : 'text-text-tertiary hover:text-text-secondary hover:bg-bg-hover'
                )}
              >
                {config && <config.icon size={12} className={isActive ? config.color : ''} />}
                <span className="capitalize">{level}</span>
                <span className={cn('text-[10px] tabular-nums', isActive ? 'text-text-secondary' : 'text-text-muted')}>
                  {levelCounts[level] || 0}
                </span>
              </button>
            );
          })}
        </div>
        <div className="w-56 ml-auto">
          <SearchInput
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter logs..."
          />
        </div>
      </div>

      {/* Log stream */}
      <div className="flex-1 overflow-y-auto">
        {filtered.map((entry) => {
          const config = LEVEL_CONFIG[entry.level] || LEVEL_CONFIG.log;
          const Icon = config.icon;
          const isExpanded = expandedId === entry.eventId;
          const hasDetails = (entry.args && entry.args.length > 0) || entry.stackTrace;

          return (
            <div key={entry.eventId} className="border-b border-border-muted">
              <div
                onClick={() => hasDetails && setExpandedId(isExpanded ? null : entry.eventId)}
                className={cn(
                  'flex items-start gap-3 px-5 py-2 transition-colors',
                  hasDetails && 'cursor-pointer hover:bg-bg-hover',
                  isExpanded && 'bg-bg-hover'
                )}
              >
                {hasDetails && (
                  <ChevronRight
                    size={12}
                    className={cn('mt-1 shrink-0 text-text-muted transition-transform', isExpanded && 'rotate-90')}
                  />
                )}
                {!hasDetails && <div className="w-3 shrink-0" />}
                <Icon size={14} strokeWidth={1.75} className={cn('mt-0.5 shrink-0', config.color)} />
                <span className="text-[11px] font-mono text-text-muted tabular-nums shrink-0 mt-0.5">
                  {formatTimestamp(entry.timestamp)}
                </span>
                <span className={cn('text-[13px] flex-1 min-w-0', entry.level === 'error' ? 'text-red' : 'text-text-primary')}>
                  {entry.message}
                </span>
                {entry.sourceFile && (
                  <span className="text-[11px] text-text-muted shrink-0 font-mono">{entry.sourceFile}</span>
                )}
              </div>

              {isExpanded && (
                <div className="px-5 pb-3 pl-16 space-y-3">
                  {entry.args && entry.args.length > 0 && (
                    <div>
                      <p className="text-[11px] font-medium text-text-muted uppercase tracking-wider mb-1">Arguments</p>
                      <div className="bg-bg-elevated rounded-md p-3 border border-border-muted">
                        <JsonViewer data={entry.args.length === 1 ? entry.args[0] : entry.args} defaultExpanded={true} />
                      </div>
                    </div>
                  )}
                  {entry.stackTrace && (
                    <div>
                      <p className="text-[11px] font-medium text-text-muted uppercase tracking-wider mb-1">Stack Trace</p>
                      <div className="bg-bg-elevated rounded-md py-2 border border-border-muted">
                        <StackTrace trace={entry.stackTrace} />
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
