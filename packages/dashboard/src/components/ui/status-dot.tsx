import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/cn';

const dotVariants = cva('inline-block rounded-full shrink-0', {
  variants: {
    color: {
      green: 'bg-green',
      blue: 'bg-blue',
      purple: 'bg-purple',
      amber: 'bg-amber',
      red: 'bg-red',
      orange: 'bg-orange',
      cyan: 'bg-cyan',
      gray: 'bg-text-tertiary',
      brand: 'bg-brand',
    },
    size: {
      sm: 'w-1.5 h-1.5',
      md: 'w-2 h-2',
      lg: 'w-2.5 h-2.5',
    },
    pulse: {
      true: 'animate-pulse',
      false: '',
    },
  },
  defaultVariants: {
    color: 'green',
    size: 'md',
    pulse: false,
  },
});

interface StatusDotProps
  extends Omit<React.HTMLAttributes<HTMLSpanElement>, 'color'>,
    VariantProps<typeof dotVariants> {}

export function StatusDot({ className, color, size, pulse, ...props }: StatusDotProps) {
  return <span className={cn(dotVariants({ color, size, pulse }), className)} {...props} />;
}
