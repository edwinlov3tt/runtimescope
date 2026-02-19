import { forwardRef } from 'react';
import { cn } from '@/lib/cn';
import { Search } from 'lucide-react';

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  icon?: React.ReactNode;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ className, icon, ...props }, ref) => {
    return (
      <div className="relative">
        {icon && (
          <div className="absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary">
            {icon}
          </div>
        )}
        <input
          ref={ref}
          className={cn(
            'w-full h-9 rounded-md bg-bg-input text-text-primary text-sm',
            'border border-border-strong placeholder:text-text-muted',
            'focus:border-border-hover focus:outline-none',
            'transition-colors',
            icon ? 'pl-9 pr-3' : 'px-3',
            className
          )}
          {...props}
        />
      </div>
    );
  }
);
Input.displayName = 'Input';

export function SearchInput(props: Omit<InputProps, 'icon'>) {
  return <Input icon={<Search size={15} />} placeholder="Search..." {...props} />;
}
