import { cn } from '@/lib/cn';
import { Copy, Check } from 'lucide-react';
import { useState, useCallback } from 'react';

interface CodeBlockProps {
  children: string;
  language?: string;
  className?: string;
  copyable?: boolean;
}

export function CodeBlock({ children, language, className, copyable = true }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(children);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [children]);

  return (
    <div className={cn('relative group rounded-md border border-border-default bg-bg-input', className)}>
      {copyable && (
        <button
          onClick={handleCopy}
          className="absolute top-2 right-2 p-1.5 rounded-md text-text-muted hover:text-text-secondary hover:bg-bg-hover opacity-0 group-hover:opacity-100 transition-all cursor-pointer"
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
      )}
      {language && (
        <div className="px-3 py-1.5 border-b border-border-muted">
          <span className="text-[10px] font-medium text-text-muted uppercase tracking-wider">
            {language}
          </span>
        </div>
      )}
      <pre className="p-3 overflow-x-auto">
        <code className="font-mono text-[13px] leading-relaxed text-text-secondary">
          {children}
        </code>
      </pre>
    </div>
  );
}
