import { useState, useMemo, useCallback, memo } from 'react';
import { Topbar } from '@/components/layout/topbar';
import { Badge, JsonViewer } from '@/components/ui';
import { SearchInput } from '@/components/ui/input';
import { ExportButton } from '@/components/ui/export-button';
import { ListSkeleton } from '@/components/ui/skeleton';
import { useDataStore } from '@/stores/use-data-store';
import { useConnected } from '@/hooks/use-connected';
import { formatTimestamp } from '@/lib/format';
import { cn } from '@/lib/cn';
import {
  MousePointerClick,
  Navigation,
  Globe,
  Terminal,
  AlertCircle,
  AlertTriangle,
  Database,
  Tag,
  Bookmark,
  ChevronRight,
} from 'lucide-react';
import type { UIInteractionEvent, ConsoleEvent, NetworkEvent, NavigationEvent as NavEvent } from '@/lib/runtime-types';

// ---------------------------------------------------------------------------
// Breadcrumb model — unified from multiple event types
// ---------------------------------------------------------------------------

interface Breadcrumb {
  id: string;
  timestamp: number;
  category: string;
  level: 'debug' | 'info' | 'warning' | 'error';
  message: string;
  icon: typeof MousePointerClick;
  color: string;
  data?: Record<string, unknown>;
}

const CATEGORY_CONFIG: Record<string, { icon: typeof MousePointerClick; color: string }> = {
  'ui.click':    { icon: MousePointerClick, color: 'text-blue' },
  'breadcrumb':  { icon: Bookmark, color: 'text-purple' },
  'navigation':  { icon: Navigation, color: 'text-cyan' },
  'console.log': { icon: Terminal, color: 'text-text-secondary' },
  'console.info': { icon: Terminal, color: 'text-blue' },
  'console.warn': { icon: AlertTriangle, color: 'text-amber' },
  'console.error': { icon: AlertCircle, color: 'text-red' },
  'console.debug': { icon: Terminal, color: 'text-text-muted' },
  'http':        { icon: Globe, color: 'text-green' },
  'http.error':  { icon: Globe, color: 'text-red' },
  'state':       { icon: Database, color: 'text-indigo' },
  'custom':      { icon: Tag, color: 'text-teal' },
};

function getCategoryConfig(category: string) {
  return CATEGORY_CONFIG[category] ?? { icon: Tag, color: 'text-text-muted' };
}

type BadgeVariant = 'red' | 'amber' | 'blue' | 'default';
const LEVEL_BADGES: Record<string, BadgeVariant> = {
  error: 'red',
  warning: 'amber',
  info: 'blue',
  debug: 'default',
};

// ---------------------------------------------------------------------------
// Convert raw events into breadcrumbs
// ---------------------------------------------------------------------------

function uiToBreadcrumbs(events: UIInteractionEvent[]): Breadcrumb[] {
  return events.map((e) => {
    const isClick = e.action === 'click';
    const category = isClick ? 'ui.click' : 'breadcrumb';
    const config = getCategoryConfig(category);
    return {
      id: `ui-${e.eventId}`,
      timestamp: e.timestamp,
      category,
      level: 'info' as const,
      message: isClick
        ? (e.text ? `Click: ${e.text}` : `Click: ${e.target}`)
        : (e.text ?? e.target),
      icon: config.icon,
      color: config.color,
      data: { target: e.target, ...e.data },
    };
  });
}

function consoleToBreadcrumbs(events: ConsoleEvent[]): Breadcrumb[] {
  return events.map((e) => {
    const category = `console.${e.level}`;
    const config = getCategoryConfig(category);
    const level = e.level === 'error' ? 'error'
      : e.level === 'warn' ? 'warning'
      : e.level === 'debug' || e.level === 'trace' ? 'debug'
      : 'info';
    return {
      id: `con-${e.eventId}`,
      timestamp: e.timestamp,
      category,
      level: level as Breadcrumb['level'],
      message: e.message.slice(0, 200),
      icon: config.icon,
      color: config.color,
      ...(e.stackTrace && { data: { hasStack: true } }),
    };
  });
}

function networkToBreadcrumbs(events: NetworkEvent[]): Breadcrumb[] {
  return events.map((e) => {
    const isError = e.errorPhase || e.status >= 400;
    const category = isError ? 'http.error' : 'http';
    const config = getCategoryConfig(category);
    let path: string;
    try {
      path = new URL(e.url).pathname;
    } catch {
      path = e.url;
    }
    return {
      id: `net-${e.eventId}`,
      timestamp: e.timestamp,
      category,
      level: isError ? 'error' as const : 'info' as const,
      message: `${e.method} ${path} \u2192 ${e.status || e.errorPhase || 'pending'}`,
      icon: config.icon,
      color: config.color,
      data: { duration: e.duration, status: e.status, url: e.url },
    };
  });
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

const CATEGORIES = ['all', 'ui.click', 'breadcrumb', 'console', 'http', 'navigation'] as const;

const LEVELS = ['all', 'error', 'warning', 'info', 'debug'] as const;
const LEVEL_ORDER: Record<string, number> = { debug: 0, info: 1, warning: 2, error: 3 };

const RENDER_CAP = 300;

// ---------------------------------------------------------------------------
// Row component
// ---------------------------------------------------------------------------

const BreadcrumbRow = memo(function BreadcrumbRow({
  entry,
  isExpanded,
  onToggle,
}: {
  entry: Breadcrumb;
  isExpanded: boolean;
  onToggle: (id: string) => void;
}) {
  const config = getCategoryConfig(entry.category);
  const Icon = config.icon;
  const hasData = entry.data && Object.keys(entry.data).length > 0;

  return (
    <div className="border-b border-border-muted">
      <div
        onClick={() => hasData && onToggle(entry.id)}
        className={cn(
          'flex items-center gap-3 px-5 py-2 transition-colors',
          hasData && 'cursor-pointer hover:bg-bg-hover',
          isExpanded && 'bg-bg-hover'
        )}
      >
        {hasData && (
          <ChevronRight
            size={12}
            className={cn('shrink-0 text-text-muted transition-transform', isExpanded && 'rotate-90')}
          />
        )}
        {!hasData && <div className="w-3 shrink-0" />}
        <Icon size={14} strokeWidth={1.75} className={cn('shrink-0', config.color)} />
        <span className="text-[11px] font-mono text-text-muted tabular-nums shrink-0">
          {formatTimestamp(entry.timestamp)}
        </span>
        <span className={cn(
          'text-[13px] flex-1 min-w-0 truncate',
          entry.level === 'error' ? 'text-red' : entry.level === 'warning' ? 'text-amber' : 'text-text-primary'
        )}>
          {entry.message}
        </span>
        <Badge variant={LEVEL_BADGES[entry.level] ?? 'default'} className="shrink-0 text-[10px]">
          {entry.category}
        </Badge>
      </div>

      {isExpanded && hasData && (
        <div className="px-5 pb-3 pl-16">
          <div className="bg-bg-elevated rounded-md p-3 border border-border-muted">
            <JsonViewer data={entry.data} defaultExpanded={true} />
          </div>
        </div>
      )}
    </div>
  );
});

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export function BreadcrumbsPage() {
  const [activeCategory, setActiveCategory] = useState<string>('all');
  const [activeLevel, setActiveLevel] = useState<string>('all');
  const [search, setSearch] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const connected = useConnected();
  const initialLoadDone = useDataStore((s) => s.initialLoadDone);

  // Pull from multiple stores and merge into a unified breadcrumb trail
  const uiEvents = useDataStore((s) => s.ui);
  const consoleEvents = useDataStore((s) => s.console);
  const networkEvents = useDataStore((s) => s.network);

  const breadcrumbs = useMemo(() => {
    const all: Breadcrumb[] = [
      ...uiToBreadcrumbs(uiEvents),
      ...consoleToBreadcrumbs(consoleEvents),
      ...networkToBreadcrumbs(networkEvents),
    ];
    // Sort chronologically (oldest first)
    all.sort((a, b) => a.timestamp - b.timestamp);
    return all;
  }, [uiEvents, consoleEvents, networkEvents]);

  const categoryCounts = useMemo(() => {
    const counts: Record<string, number> = { all: breadcrumbs.length };
    for (const bc of breadcrumbs) {
      // Group console.* under "console"
      const group = bc.category.startsWith('console') ? 'console'
        : bc.category.startsWith('http') ? 'http'
        : bc.category;
      counts[group] = (counts[group] ?? 0) + 1;
    }
    return counts;
  }, [breadcrumbs]);

  const filtered = useMemo(() => {
    let data = breadcrumbs;
    if (activeCategory !== 'all') {
      data = data.filter((bc) => {
        if (activeCategory === 'console') return bc.category.startsWith('console');
        if (activeCategory === 'http') return bc.category.startsWith('http');
        return bc.category === activeCategory;
      });
    }
    if (activeLevel !== 'all') {
      const minLevel = LEVEL_ORDER[activeLevel] ?? 0;
      data = data.filter((bc) => (LEVEL_ORDER[bc.level] ?? 0) >= minLevel);
    }
    if (search) {
      const q = search.toLowerCase();
      data = data.filter((bc) => bc.message.toLowerCase().includes(q) || bc.category.includes(q));
    }
    return data;
  }, [breadcrumbs, activeCategory, activeLevel, search]);

  const rendered = useMemo(
    () => (showAll || filtered.length <= RENDER_CAP ? filtered : filtered.slice(-RENDER_CAP)),
    [filtered, showAll],
  );
  const isCapped = !showAll && filtered.length > RENDER_CAP;

  const handleToggle = useCallback((id: string) => {
    setExpandedId((prev) => (prev === id ? null : id));
  }, []);

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
      <Topbar title="Breadcrumbs" connected={connected} />

      {/* Category + level filters */}
      <div className="border-b border-border-default px-5 py-2.5 flex items-center gap-3">
        <div className="flex items-center gap-1">
          {CATEGORIES.map((cat) => {
            const isActive = activeCategory === cat;
            const config = cat === 'all' ? null : getCategoryConfig(cat);
            return (
              <button
                key={cat}
                onClick={() => setActiveCategory(cat)}
                className={cn(
                  'h-7 px-2.5 rounded-md text-[12px] font-medium transition-colors cursor-pointer flex items-center gap-1.5',
                  isActive
                    ? 'bg-bg-elevated text-text-primary'
                    : 'text-text-tertiary hover:text-text-secondary hover:bg-bg-hover'
                )}
              >
                {config && <config.icon size={12} className={isActive ? config.color : ''} />}
                <span className="capitalize">{cat === 'ui.click' ? 'Clicks' : cat === 'http' ? 'HTTP' : cat}</span>
                <span className={cn('text-[10px] tabular-nums', isActive ? 'text-text-secondary' : 'text-text-muted')}>
                  {categoryCounts[cat] ?? 0}
                </span>
              </button>
            );
          })}
        </div>

        <div className="h-4 w-px bg-border-default" />

        {/* Level filter */}
        <div className="flex items-center gap-1">
          {LEVELS.map((lvl) => {
            const isActive = activeLevel === lvl;
            return (
              <button
                key={lvl}
                onClick={() => setActiveLevel(lvl)}
                className={cn(
                  'h-7 px-2 rounded-md text-[11px] font-medium transition-colors cursor-pointer capitalize',
                  isActive
                    ? 'bg-bg-elevated text-text-primary'
                    : 'text-text-tertiary hover:text-text-secondary hover:bg-bg-hover'
                )}
              >
                {lvl}
              </button>
            );
          })}
        </div>

        <div className="flex items-center gap-2 ml-auto">
          <div className="w-56">
            <SearchInput
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search breadcrumbs..."
            />
          </div>
          <ExportButton data={filtered as unknown as Record<string, unknown>[]} filename="breadcrumbs" />
        </div>
      </div>

      {/* Breadcrumb stream */}
      <div className="flex-1 overflow-y-auto">
        {!initialLoadDone && breadcrumbs.length === 0 ? (
          <ListSkeleton rows={12} />
        ) : breadcrumbs.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-text-muted">
            <Bookmark size={32} strokeWidth={1} className="mb-3 opacity-40" />
            <p className="text-sm font-medium">No breadcrumbs yet</p>
            <p className="text-xs mt-1">Clicks, console logs, and network requests will appear here as a timeline.</p>
          </div>
        ) : (
          <>
            {rendered.map((entry) => (
              <BreadcrumbRow
                key={entry.id}
                entry={entry}
                isExpanded={expandedId === entry.id}
                onToggle={handleToggle}
              />
            ))}
            {isCapped && (
              <div className="px-5 py-3 text-center">
                <button
                  onClick={() => setShowAll(true)}
                  className="text-xs text-text-tertiary hover:text-text-secondary transition-colors"
                >
                  Showing {RENDER_CAP} of {filtered.length} entries — click to show all
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
