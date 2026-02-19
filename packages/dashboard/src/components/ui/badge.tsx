import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/cn';

const badgeVariants = cva(
  'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors border',
  {
    variants: {
      variant: {
        default: 'bg-bg-elevated text-text-secondary border-border-default',
        brand: 'bg-brand-muted text-brand border-brand-border',
        green: 'bg-green-muted text-green border-green-border',
        blue: 'bg-blue-muted text-blue border-blue-border',
        purple: 'bg-purple-muted text-purple border-purple-border',
        amber: 'bg-amber-muted text-amber border-amber-border',
        red: 'bg-red-muted text-red border-red-border',
        orange: 'bg-orange-muted text-orange border-orange-border',
        cyan: 'bg-cyan-muted text-cyan border-cyan-border',
      },
      size: {
        sm: 'text-[10px] px-1.5 py-px',
        md: 'text-xs px-2.5 py-0.5',
        lg: 'text-sm px-3 py-1',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'md',
    },
  }
);

interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, size, ...props }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ variant, size }), className)} {...props} />
  );
}
