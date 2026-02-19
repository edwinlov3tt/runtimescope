import { useState, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { cn } from '@/lib/cn';

interface JsonViewerProps {
  data: unknown;
  defaultExpanded?: boolean;
  className?: string;
}

export function JsonViewer({ data, defaultExpanded = true, className }: JsonViewerProps) {
  return (
    <div className={cn('font-mono text-[13px] leading-relaxed', className)}>
      <JsonNode value={data} depth={0} defaultExpanded={defaultExpanded} />
    </div>
  );
}

function JsonNode({ value, depth, defaultExpanded }: { value: unknown; depth: number; defaultExpanded: boolean }) {
  if (value === null) return <span className="text-text-muted">null</span>;
  if (value === undefined) return <span className="text-text-muted">undefined</span>;
  if (typeof value === 'boolean') return <span className="text-purple">{String(value)}</span>;
  if (typeof value === 'number') return <span className="text-cyan">{value}</span>;
  if (typeof value === 'string') return <span className="text-green">"{value}"</span>;

  if (Array.isArray(value)) {
    return <JsonExpandable label={`Array(${value.length})`} depth={depth} defaultExpanded={defaultExpanded && depth < 2} bracketOpen="[" bracketClose="]">
      {value.map((item, i) => (
        <div key={i} className="flex" style={{ paddingLeft: (depth + 1) * 16 }}>
          <span className="text-text-muted mr-1">{i}:</span>
          <JsonNode value={item} depth={depth + 1} defaultExpanded={defaultExpanded} />
        </div>
      ))}
    </JsonExpandable>;
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    return <JsonExpandable label={`{${entries.length}}`} depth={depth} defaultExpanded={defaultExpanded && depth < 2} bracketOpen="{" bracketClose="}">
      {entries.map(([key, val]) => (
        <div key={key} className="flex" style={{ paddingLeft: (depth + 1) * 16 }}>
          <span className="text-brand mr-1">{key}:</span>
          <JsonNode value={val} depth={depth + 1} defaultExpanded={defaultExpanded} />
        </div>
      ))}
    </JsonExpandable>;
  }

  return <span className="text-text-primary">{String(value)}</span>;
}

function JsonExpandable({
  label,
  depth,
  defaultExpanded,
  bracketOpen,
  bracketClose,
  children,
}: {
  label: string;
  depth: number;
  defaultExpanded: boolean;
  bracketOpen: string;
  bracketClose: string;
  children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  return (
    <div>
      <button
        onClick={() => setExpanded(!expanded)}
        className="inline-flex items-center gap-0.5 cursor-pointer hover:bg-bg-hover rounded px-0.5"
      >
        <ChevronRight
          size={12}
          className={cn('text-text-muted transition-transform', expanded && 'rotate-90')}
        />
        <span className="text-text-muted">
          {expanded ? bracketOpen : `${bracketOpen}${label}${bracketClose}`}
        </span>
      </button>
      {expanded && (
        <>
          {children}
          <div style={{ paddingLeft: depth * 16 }}>
            <span className="text-text-muted">{bracketClose}</span>
          </div>
        </>
      )}
    </div>
  );
}
