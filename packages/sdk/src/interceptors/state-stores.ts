import { generateId } from '../utils/id.js';
import { safeSerialize } from '../utils/serialize.js';
import type { StateEvent, RuntimeEvent } from '../types.js';

type EmitFn = (event: StateEvent) => void;

export interface StateStoreOptions {
  beforeSend?: (event: RuntimeEvent) => RuntimeEvent | null;
}

interface ZustandStore {
  getState: () => unknown;
  setState: (partial: unknown) => void;
  subscribe: (listener: (state: unknown, prevState: unknown) => void) => () => void;
}

interface ReduxStore {
  getState: () => unknown;
  dispatch: (action: unknown) => unknown;
  subscribe: (listener: () => void) => () => void;
}

type DetectedLibrary = 'zustand' | 'redux' | 'unknown';

export function interceptStateStores(
  emit: EmitFn,
  sessionId: string,
  stores: Record<string, unknown>,
  options?: StateStoreOptions
): () => void {
  const unsubscribers: (() => void)[] = [];
  const originalDispatches: Map<string, ReduxStore['dispatch']> = new Map();

  for (const [storeId, store] of Object.entries(stores)) {
    const library = detectLibrary(store);

    if (library === 'zustand') {
      const zustand = store as ZustandStore;

      // Emit initial state
      emitState(emit, sessionId, options?.beforeSend, {
        storeId,
        library,
        phase: 'init',
        state: safeSerialize(zustand.getState(), 4),
      });

      // Subscribe to changes
      const unsub = zustand.subscribe((state, prevState) => {
        const diff = shallowDiff(prevState, state);
        emitState(emit, sessionId, options?.beforeSend, {
          storeId,
          library,
          phase: 'update',
          state: safeSerialize(state, 4),
          previousState: safeSerialize(prevState, 4),
          diff: diff ? safeSerialize(diff, 3) as Record<string, { from: unknown; to: unknown }> : undefined,
        });
      });

      unsubscribers.push(unsub);
    } else if (library === 'redux') {
      const redux = store as ReduxStore;

      // Emit initial state
      emitState(emit, sessionId, options?.beforeSend, {
        storeId,
        library,
        phase: 'init',
        state: safeSerialize(redux.getState(), 4),
      });

      // Wrap dispatch to capture actions
      let lastAction: { type: string; payload?: unknown } | undefined;
      const origDispatch = redux.dispatch.bind(redux);
      originalDispatches.set(storeId, origDispatch);

      (redux as { dispatch: ReduxStore['dispatch'] }).dispatch = (action: unknown) => {
        if (action && typeof action === 'object' && 'type' in action) {
          lastAction = {
            type: String((action as { type: unknown }).type),
            payload: (action as { payload?: unknown }).payload,
          };
        }
        return origDispatch(action);
      };

      // Subscribe to state changes
      let prevState = redux.getState();
      const unsub = redux.subscribe(() => {
        const state = redux.getState();
        const diff = shallowDiff(prevState, state);

        emitState(emit, sessionId, options?.beforeSend, {
          storeId,
          library,
          phase: 'update',
          state: safeSerialize(state, 4),
          previousState: safeSerialize(prevState, 4),
          diff: diff ? safeSerialize(diff, 3) as Record<string, { from: unknown; to: unknown }> : undefined,
          action: lastAction ? safeSerialize(lastAction, 3) as { type: string; payload?: unknown } : undefined,
        });

        prevState = state;
        lastAction = undefined;
      });

      unsubscribers.push(unsub);
    }
  }

  return () => {
    for (const unsub of unsubscribers) unsub();

    // Restore original Redux dispatch functions
    for (const [storeId, origDispatch] of originalDispatches) {
      const store = stores[storeId] as ReduxStore;
      if (store) {
        (store as { dispatch: ReduxStore['dispatch'] }).dispatch = origDispatch;
      }
    }
  };
}

function detectLibrary(store: unknown): DetectedLibrary {
  if (!store || typeof store !== 'object') return 'unknown';
  const s = store as Record<string, unknown>;

  // Zustand: function-like with getState, setState, subscribe
  if (
    typeof s.getState === 'function' &&
    typeof s.setState === 'function' &&
    typeof s.subscribe === 'function'
  ) {
    return 'zustand';
  }

  // Redux: object with dispatch, getState, subscribe
  if (
    typeof s.dispatch === 'function' &&
    typeof s.getState === 'function' &&
    typeof s.subscribe === 'function'
  ) {
    return 'redux';
  }

  return 'unknown';
}

function shallowDiff(
  prev: unknown,
  curr: unknown
): Record<string, { from: unknown; to: unknown }> | null {
  if (!prev || !curr || typeof prev !== 'object' || typeof curr !== 'object') {
    return null;
  }

  const diff: Record<string, { from: unknown; to: unknown }> = {};
  const prevObj = prev as Record<string, unknown>;
  const currObj = curr as Record<string, unknown>;
  const allKeys = new Set([...Object.keys(prevObj), ...Object.keys(currObj)]);

  for (const key of allKeys) {
    if (prevObj[key] !== currObj[key]) {
      diff[key] = { from: prevObj[key], to: currObj[key] };
    }
  }

  return Object.keys(diff).length > 0 ? diff : null;
}

function emitState(
  emit: EmitFn,
  sessionId: string,
  beforeSend: ((event: RuntimeEvent) => RuntimeEvent | null) | undefined,
  data: Omit<StateEvent, 'eventId' | 'sessionId' | 'timestamp' | 'eventType'>
): void {
  const event: StateEvent = {
    eventId: generateId(),
    sessionId,
    timestamp: Date.now(),
    eventType: 'state',
    ...data,
  };

  if (beforeSend) {
    const filtered = beforeSend(event);
    if (filtered) emit(filtered as StateEvent);
  } else {
    emit(event);
  }
}
