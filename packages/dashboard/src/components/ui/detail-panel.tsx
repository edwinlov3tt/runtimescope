import { useEffect, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/cn';

interface DetailPanelProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  subtitle?: string;
  children: ReactNode;
  className?: string;
}

export function DetailPanel({ open, onClose, title, subtitle, children, className }: DetailPanelProps) {
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className={cn(
        'w-[380px] shrink-0 border-l border-border-default bg-bg-surface flex flex-col overflow-hidden',
        'animate-in slide-in-from-right duration-200',
        className
      )}
    >
      {/* Header */}
      <div className="h-12 flex items-center justify-between px-4 border-b border-border-default shrink-0">
        <div className="min-w-0">
          {title && <h3 className="text-[13px] font-semibold text-text-primary truncate">{title}</h3>}
          {subtitle && <p className="text-[11px] text-text-tertiary truncate">{subtitle}</p>}
        </div>
        <button
          onClick={onClose}
          className="w-7 h-7 flex items-center justify-center rounded-md text-text-tertiary hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer"
        >
          <X size={14} />
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {children}
      </div>
    </div>
  );
}
