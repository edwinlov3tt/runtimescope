import { cn } from '@/lib/cn';

interface StackTraceProps {
  trace: string;
  className?: string;
}

export function StackTrace({ trace, className }: StackTraceProps) {
  const lines = trace.split('\n').filter(Boolean);

  return (
    <div className={cn('font-mono text-[12px] leading-relaxed', className)}>
      {lines.map((line, i) => {
        const isFrame = line.trim().startsWith('at ');
        const fileMatch = line.match(/\((.+?):(\d+):(\d+)\)/) || line.match(/at (.+?):(\d+):(\d+)/);

        return (
          <div
            key={i}
            className={cn(
              'px-3 py-0.5',
              i === 0 && 'text-red font-medium',
              isFrame && 'text-text-tertiary',
              isFrame && fileMatch && 'hover:bg-bg-hover cursor-pointer'
            )}
          >
            {isFrame && fileMatch ? (
              <>
                <span className="text-text-muted">{'  at '}</span>
                <span className="text-text-secondary">
                  {line.trim().slice(3, line.trim().indexOf('(') > -1 ? line.trim().indexOf('(') : undefined).trim()}
                </span>
                {fileMatch && (
                  <span className="text-text-muted">
                    {' ('}
                    <span className="text-cyan">{fileMatch[1]}</span>
                    <span>:{fileMatch[2]}:{fileMatch[3]}</span>
                    {')'}
                  </span>
                )}
              </>
            ) : (
              <span>{line}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}
