import { generateId } from '../utils/id.js';
import type { RenderEvent, RenderComponentProfile, RuntimeEvent } from '../types.js';

type EmitFn = (event: RenderEvent) => void;

export interface RenderInterceptorOptions {
  beforeSend?: (event: RuntimeEvent) => RuntimeEvent | null;
  snapshotIntervalMs?: number;
}

interface Fiber {
  tag: number;
  type: { displayName?: string; name?: string } | string | null;
  child: Fiber | null;
  sibling: Fiber | null;
  alternate: Fiber | null;
  memoizedProps: unknown;
  memoizedState: unknown;
  actualDuration?: number;
  stateNode: unknown;
}

interface ComponentTracker {
  renderCount: number;
  totalDuration: number;
  lastRenderTime: number;
  lastRenderPhase: 'mount' | 'update' | 'unmount';
  lastRenderCause: 'props' | 'state' | 'context' | 'parent' | 'unknown';
  renderTimestamps: number[];
}

interface DevToolsHook {
  onCommitFiberRoot?: (id: number, root: { current?: Fiber }) => void;
  _runtimescope_original?: (id: number, root: { current?: Fiber }) => void;
}

const FUNCTION_COMPONENT = 0;
const CLASS_COMPONENT = 1;
const SNAPSHOT_WINDOW_MS = 10_000;
const MAX_TIMESTAMPS = 100;

export function interceptReactRenders(
  emit: EmitFn,
  sessionId: string,
  options?: RenderInterceptorOptions
): () => void {
  const trackers = new Map<string, ComponentTracker>();
  const snapshotIntervalMs = options?.snapshotIntervalMs ?? 5000;
  let snapshotTimer: ReturnType<typeof setInterval> | null = null;

  // Access or create the React DevTools global hook
  const hook = getOrCreateDevToolsHook();
  if (!hook) {
    return () => {}; // Not in a browser environment
  }

  // Save original if React DevTools is installed
  const originalOnCommit = hook.onCommitFiberRoot;
  hook._runtimescope_original = originalOnCommit;

  hook.onCommitFiberRoot = (id: number, root: { current?: Fiber }) => {
    // Call original first (React DevTools compatibility)
    if (originalOnCommit) {
      try {
        originalOnCommit(id, root);
      } catch {
        // Don't let DevTools errors break our tracking
      }
    }

    if (root.current) {
      walkFiber(root.current, trackers);
    }
  };

  // Emit snapshots periodically
  snapshotTimer = setInterval(() => {
    emitSnapshot(trackers, emit, sessionId, options?.beforeSend);
  }, snapshotIntervalMs);

  return () => {
    if (snapshotTimer) {
      clearInterval(snapshotTimer);
      snapshotTimer = null;
    }

    // Restore original hook
    if (hook) {
      if (hook._runtimescope_original) {
        hook.onCommitFiberRoot = hook._runtimescope_original;
      } else {
        delete hook.onCommitFiberRoot;
      }
      delete hook._runtimescope_original;
    }
  };
}

function getOrCreateDevToolsHook(): DevToolsHook | null {
  if (typeof window === 'undefined') return null;

  const w = window as unknown as { __REACT_DEVTOOLS_GLOBAL_HOOK__?: DevToolsHook };

  if (!w.__REACT_DEVTOOLS_GLOBAL_HOOK__) {
    // Create a minimal shim that React will pick up on init
    w.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      // React checks for these methods to decide if DevTools is present
    } as DevToolsHook;
  }

  return w.__REACT_DEVTOOLS_GLOBAL_HOOK__!;
}

function walkFiber(fiber: Fiber, trackers: Map<string, ComponentTracker>): void {
  processNode(fiber, trackers);

  if (fiber.child) walkFiber(fiber.child, trackers);
  if (fiber.sibling) walkFiber(fiber.sibling, trackers);
}

function processNode(fiber: Fiber, trackers: Map<string, ComponentTracker>): void {
  // Only track function components (0) and class components (1)
  if (fiber.tag !== FUNCTION_COMPONENT && fiber.tag !== CLASS_COMPONENT) return;

  const name = getComponentName(fiber);
  if (!name) return;

  const now = Date.now();
  const isMount = fiber.alternate === null;
  const duration = fiber.actualDuration ?? 0;
  const cause = inferRenderCause(fiber, isMount);

  let tracker = trackers.get(name);
  if (!tracker) {
    tracker = {
      renderCount: 0,
      totalDuration: 0,
      lastRenderTime: 0,
      lastRenderPhase: 'mount',
      lastRenderCause: 'unknown',
      renderTimestamps: [],
    };
    trackers.set(name, tracker);
  }

  tracker.renderCount++;
  tracker.totalDuration += duration;
  tracker.lastRenderTime = now;
  tracker.lastRenderPhase = isMount ? 'mount' : 'update';
  tracker.lastRenderCause = cause;
  tracker.renderTimestamps.push(now);

  // Trim old timestamps
  if (tracker.renderTimestamps.length > MAX_TIMESTAMPS) {
    tracker.renderTimestamps = tracker.renderTimestamps.slice(-MAX_TIMESTAMPS);
  }
}

function getComponentName(fiber: Fiber): string | undefined {
  if (!fiber.type) return undefined;
  if (typeof fiber.type === 'string') return undefined; // HTML elements
  return fiber.type.displayName || fiber.type.name || undefined;
}

function inferRenderCause(
  fiber: Fiber,
  isMount: boolean
): RenderComponentProfile['lastRenderCause'] {
  if (isMount) return 'props'; // Initial mount, driven by parent passing props

  if (!fiber.alternate) return 'unknown';

  // Check if props changed
  if (fiber.memoizedProps !== fiber.alternate.memoizedProps) {
    return 'props';
  }

  // Check if state changed
  if (fiber.memoizedState !== fiber.alternate.memoizedState) {
    return 'state';
  }

  // If neither props nor state changed, likely parent re-rendered
  return 'parent';
}

function computeRenderVelocity(timestamps: number[]): number {
  if (timestamps.length < 2) return 0;
  const now = Date.now();
  const windowStart = now - SNAPSHOT_WINDOW_MS;
  const recent = timestamps.filter((t) => t >= windowStart);
  if (recent.length < 2) return 0;
  const windowMs = now - recent[0];
  if (windowMs === 0) return 0;
  return recent.length / (windowMs / 1000);
}

function emitSnapshot(
  trackers: Map<string, ComponentTracker>,
  emit: EmitFn,
  sessionId: string,
  beforeSend?: (event: RuntimeEvent) => RuntimeEvent | null
): void {
  if (trackers.size === 0) return;

  const profiles: RenderComponentProfile[] = [];
  const suspiciousComponents: string[] = [];
  let totalRenders = 0;

  for (const [componentName, tracker] of trackers) {
    const velocity = computeRenderVelocity(tracker.renderTimestamps);
    const suspicious = velocity > 4 || tracker.renderCount > 20;

    profiles.push({
      componentName,
      renderCount: tracker.renderCount,
      totalDuration: Math.round(tracker.totalDuration * 100) / 100,
      avgDuration:
        tracker.renderCount > 0
          ? Math.round((tracker.totalDuration / tracker.renderCount) * 100) / 100
          : 0,
      lastRenderPhase: tracker.lastRenderPhase,
      lastRenderCause: tracker.lastRenderCause,
      renderVelocity: Math.round(velocity * 100) / 100,
      suspicious,
    });

    if (suspicious) suspiciousComponents.push(componentName);
    totalRenders += tracker.renderCount;
  }

  // Sort by render count descending
  profiles.sort((a, b) => b.renderCount - a.renderCount);

  const event: RenderEvent = {
    eventId: generateId(),
    sessionId,
    timestamp: Date.now(),
    eventType: 'render',
    profiles,
    snapshotWindowMs: SNAPSHOT_WINDOW_MS,
    totalRenders,
    suspiciousComponents,
  };

  if (beforeSend) {
    const filtered = beforeSend(event);
    if (filtered) emit(filtered as RenderEvent);
  } else {
    emit(event);
  }

  // Reset counters for next snapshot
  for (const tracker of trackers.values()) {
    tracker.renderCount = 0;
    tracker.totalDuration = 0;
  }
}
