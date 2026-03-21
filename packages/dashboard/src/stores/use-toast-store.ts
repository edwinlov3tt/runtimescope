import { create } from 'zustand';

export type ToastVariant = 'success' | 'error' | 'info';

export interface Toast {
  id: string;
  message: string;
  variant: ToastVariant;
}

interface ToastState {
  toasts: Toast[];
  add: (message: string, variant?: ToastVariant) => void;
  remove: (id: string) => void;
}

let nextId = 0;

export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],
  add: (message, variant = 'success') => {
    const id = `toast-${++nextId}`;
    set({ toasts: [...get().toasts, { id, message, variant }] });
    setTimeout(() => {
      set({ toasts: get().toasts.filter((t) => t.id !== id) });
    }, 3000);
  },
  remove: (id) => {
    set({ toasts: get().toasts.filter((t) => t.id !== id) });
  },
}));

/** Convenience shorthand */
export const toast = {
  success: (msg: string) => useToastStore.getState().add(msg, 'success'),
  error: (msg: string) => useToastStore.getState().add(msg, 'error'),
  info: (msg: string) => useToastStore.getState().add(msg, 'info'),
};
