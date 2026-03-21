import type { RuntimeEvent, UIInteractionEvent } from '../types.js';
import { generateId } from '../utils/id.js';

/**
 * Intercepts user clicks via event delegation on `document`.
 * Emits a lightweight UIInteractionEvent with the target element's
 * CSS selector and visible text.
 *
 * Uses a single capture-phase listener — no DOM mutation, no patching.
 */
export function interceptClicks(
  emit: (event: RuntimeEvent) => void,
  sessionId: string
): () => void {
  const onClick = (e: MouseEvent) => {
    const target = e.target;
    if (!(target instanceof Element)) return;

    // Skip RuntimeScope's own UI (if any)
    if (target.closest('[data-runtimescope]')) return;

    const selector = buildSelector(target);
    const text = getVisibleText(target);

    const event: UIInteractionEvent = {
      eventId: generateId(),
      sessionId,
      timestamp: Date.now(),
      eventType: 'ui',
      action: 'click',
      target: selector,
      ...(text && { text }),
    };

    emit(event);
  };

  // Capture phase so we see clicks even if stopPropagation is called
  document.addEventListener('click', onClick, true);

  return () => {
    document.removeEventListener('click', onClick, true);
  };
}

/**
 * Build a short, human-readable CSS selector for the clicked element.
 * Prioritizes: tag + id > tag + data-testid > tag + class (first meaningful one).
 * Keeps it concise — not a full path.
 */
function buildSelector(el: Element): string {
  const tag = el.tagName.toLowerCase();

  if (el.id) return `${tag}#${el.id}`;

  const testId = el.getAttribute('data-testid') ?? el.getAttribute('data-test-id');
  if (testId) return `${tag}[data-testid="${testId}"]`;

  const role = el.getAttribute('role');
  const ariaLabel = el.getAttribute('aria-label');
  if (role && ariaLabel) return `${tag}[role="${role}"][aria-label="${ariaLabel}"]`;

  const className = el.className;
  if (typeof className === 'string' && className.trim()) {
    // Take the first non-utility class (skip single-letter or hash-based classes)
    const meaningful = className.split(/\s+/).find(
      (c) => c.length > 2 && !c.startsWith('_') && !c.includes('__')
    );
    if (meaningful) return `${tag}.${meaningful}`;
  }

  // Fallback: tag with nth-child if parent has multiple same-tag children
  const parent = el.parentElement;
  if (parent) {
    const siblings = parent.children;
    const sameTag = Array.from(siblings).filter((s) => s.tagName === el.tagName);
    if (sameTag.length > 1) {
      const idx = sameTag.indexOf(el) + 1;
      return `${tag}:nth-child(${idx})`;
    }
  }

  return tag;
}

/**
 * Get visible text from an element, truncated to 80 chars.
 * Prefers aria-label, then textContent.
 */
function getVisibleText(el: Element): string | undefined {
  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel) return ariaLabel.slice(0, 80);

  const text = (el as HTMLElement).innerText ?? el.textContent;
  if (!text) return undefined;

  const trimmed = text.trim().replace(/\s+/g, ' ');
  if (trimmed.length === 0) return undefined;
  return trimmed.length > 80 ? trimmed.slice(0, 77) + '...' : trimmed;
}
