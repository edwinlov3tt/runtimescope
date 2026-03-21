import { useState, useRef, useEffect } from 'react';
import { Download } from 'lucide-react';
import { downloadJSON, downloadCSV } from '@/lib/export';

interface ExportButtonProps {
  data: Record<string, unknown>[];
  filename: string;
  disabled?: boolean;
}

export function ExportButton({ data, filename, disabled }: ExportButtonProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  const count = data.length;

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        disabled={disabled || count === 0}
        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[12px] font-medium text-text-tertiary hover:text-text-secondary hover:bg-bg-hover transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
      >
        <Download className="w-3.5 h-3.5" />
        Export
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 bg-bg-elevated border border-border-default rounded-lg shadow-lg z-20 py-1 min-w-[140px]">
          <button
            type="button"
            onClick={() => { downloadJSON(data, filename); setOpen(false); }}
            className="w-full px-3 py-1.5 text-left text-[12px] text-text-secondary hover:bg-bg-hover transition-colors cursor-pointer"
          >
            Export JSON ({count})
          </button>
          <button
            type="button"
            onClick={() => { downloadCSV(data, filename); setOpen(false); }}
            className="w-full px-3 py-1.5 text-left text-[12px] text-text-secondary hover:bg-bg-hover transition-colors cursor-pointer"
          >
            Export CSV ({count})
          </button>
        </div>
      )}
    </div>
  );
}
