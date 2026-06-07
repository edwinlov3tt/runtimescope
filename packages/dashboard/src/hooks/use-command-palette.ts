import { useEffect, useState, useCallback } from 'react';

/**
 * Global ⌘K / Ctrl+K handler that toggles a command palette.
 *
 * Mirrors the input-focus guard used in use-keyboard-nav: the shortcut is
 * ignored while the user is typing in an input/textarea/contentEditable, so
 * ⌘K never steals focus from a text field.
 */
export function useCommandPalette() {
  const [open, setOpen] = useState(false);

  const close = useCallback(() => setOpen(false), []);
  const toggle = useCallback(() => setOpen((v) => !v), []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const isToggle = (e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K');
      if (!isToggle) return;

      // Don't hijack ⌘K while typing in a field — but always allow it to close
      // the palette again (the palette's own search input is exempt by intent).
      const target = e.target as HTMLElement | null;
      const typing =
        !!target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable);
      if (typing && !open) return;

      e.preventDefault();
      toggle();
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, toggle]);

  return { open, setOpen, close, toggle };
}
