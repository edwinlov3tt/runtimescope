import { useMemo } from 'react';
import { useDataStore } from '@/stores/use-data-store';
import { detectIssues } from '@/lib/issue-detector';
import type { DetectedIssue } from '@/lib/runtime-types';

// Module-level cache keyed on the six store array REFERENCES. When multiple
// components call this in the same commit with identical store references, only
// the first computes detectIssues(); the rest reuse the cached result. This
// collapses what used to be three independent detectIssues() useMemos (the
// notification bell, overview, and issues pages) into one shared computation.
let lastInputs: unknown[] | null = null;
let lastResult: DetectedIssue[] = [];

export function useDetectedIssues(): DetectedIssue[] {
  const network = useDataStore((s) => s.network);
  const consoleMsgs = useDataStore((s) => s.console);
  const stateEvents = useDataStore((s) => s.state);
  const renderEvents = useDataStore((s) => s.renders);
  const perfEvents = useDataStore((s) => s.performance);
  const dbEvents = useDataStore((s) => s.database);
  return useMemo(() => {
    const inputs = [network, consoleMsgs, stateEvents, renderEvents, perfEvents, dbEvents];
    if (lastInputs && inputs.every((v, i) => v === lastInputs![i])) return lastResult;
    const all = [...network, ...consoleMsgs, ...stateEvents, ...renderEvents, ...perfEvents, ...dbEvents];
    lastResult = all.length === 0 ? [] : detectIssues(all);
    lastInputs = inputs;
    return lastResult;
  }, [network, consoleMsgs, stateEvents, renderEvents, perfEvents, dbEvents]);
}
