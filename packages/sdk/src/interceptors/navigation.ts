import type { RuntimeEvent, NavigationEvent } from '../types.js';
import { generateId } from '../utils/id.js';

/**
 * Intercepts SPA navigation events:
 * - history.pushState / replaceState (client-side routing)
 * - popstate (browser back/forward)
 * - hashchange (hash-based routing)
 *
 * Emits a NavigationEvent with from/to URLs and the trigger type.
 */
export function interceptNavigation(
  emit: (event: RuntimeEvent) => void,
  sessionId: string
): () => void {
  let currentUrl = window.location.href;

  function emitNav(to: string, trigger: NavigationEvent['trigger']): void {
    const from = currentUrl;
    if (from === to) return; // Skip no-op navigations
    currentUrl = to;

    emit({
      eventId: generateId(),
      sessionId,
      timestamp: Date.now(),
      eventType: 'navigation',
      from,
      to,
      trigger,
    });
  }

  // Patch pushState and replaceState
  const origPushState = history.pushState.bind(history);
  const origReplaceState = history.replaceState.bind(history);

  history.pushState = function (...args: Parameters<typeof origPushState>) {
    origPushState(...args);
    emitNav(window.location.href, 'pushState');
  };

  history.replaceState = function (...args: Parameters<typeof origReplaceState>) {
    origReplaceState(...args);
    emitNav(window.location.href, 'replaceState');
  };

  // Listen for back/forward navigation
  const onPopState = () => emitNav(window.location.href, 'popstate');
  window.addEventListener('popstate', onPopState);

  // Listen for hash changes (covers hash-based routers)
  const onHashChange = () => emitNav(window.location.href, 'hashchange');
  window.addEventListener('hashchange', onHashChange);

  // Restore function
  return () => {
    history.pushState = origPushState;
    history.replaceState = origReplaceState;
    window.removeEventListener('popstate', onPopState);
    window.removeEventListener('hashchange', onHashChange);
  };
}
