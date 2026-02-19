import { useCallback, useEffect, useState } from 'react';

interface UseKeyboardNavOptions {
  itemCount: number;
  onSelect?: (index: number) => void;
  onDeselect?: () => void;
  enabled?: boolean;
}

export function useKeyboardNav({
  itemCount,
  onSelect,
  onDeselect,
  enabled = true,
}: UseKeyboardNavOptions) {
  const [selectedIndex, setSelectedIndex] = useState<number>(0);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!enabled || itemCount === 0) return;

      // Ignore if user is typing in an input
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return;

      switch (e.key) {
        case 'j':
        case 'ArrowDown':
          e.preventDefault();
          setSelectedIndex((prev) => {
            const next = Math.min(prev + 1, itemCount - 1);
            return next;
          });
          break;
        case 'k':
        case 'ArrowUp':
          e.preventDefault();
          setSelectedIndex((prev) => {
            const next = Math.max(prev - 1, 0);
            return next;
          });
          break;
        case 'Enter':
          e.preventDefault();
          onSelect?.(selectedIndex);
          break;
        case 'Escape':
          e.preventDefault();
          onDeselect?.();
          break;
      }
    },
    [enabled, itemCount, selectedIndex, onSelect, onDeselect]
  );

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  // Reset selection when item count changes
  useEffect(() => {
    if (selectedIndex >= itemCount) {
      setSelectedIndex(Math.max(0, itemCount - 1));
    }
  }, [itemCount, selectedIndex]);

  return { selectedIndex, setSelectedIndex };
}
