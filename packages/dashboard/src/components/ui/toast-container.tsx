import { useToastStore, type ToastVariant } from '@/stores/use-toast-store';
import { X } from 'lucide-react';

const variantStyles: Record<ToastVariant, string> = {
  success: 'bg-green-900/90 border-green-700 text-green-100',
  error: 'bg-red-900/90 border-red-700 text-red-100',
  info: 'bg-blue-900/90 border-blue-700 text-blue-100',
};

export function ToastContainer() {
  const toasts = useToastStore((s) => s.toasts);
  const remove = useToastStore((s) => s.remove);

  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-sm">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`flex items-center gap-2 px-4 py-2.5 rounded-lg border text-sm shadow-lg animate-in slide-in-from-right-5 fade-in duration-200 ${variantStyles[t.variant]}`}
        >
          <span className="flex-1">{t.message}</span>
          <button
            type="button"
            onClick={() => remove(t.id)}
            className="opacity-60 hover:opacity-100 transition-opacity cursor-pointer"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}
