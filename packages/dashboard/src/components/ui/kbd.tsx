import { cn } from '@/lib/cn';

interface KbdProps extends React.HTMLAttributes<HTMLElement> {}

export function Kbd({ className, children, ...props }: KbdProps) {
  return (
    <kbd
      className={cn(
        'inline-flex items-center justify-center h-5 min-w-5 px-1.5',
        'rounded border border-border-default bg-bg-elevated',
        'font-mono text-[10px] text-text-muted',
        className
      )}
      {...props}
    >
      {children}
    </kbd>
  );
}
