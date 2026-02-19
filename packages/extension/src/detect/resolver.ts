import type { TechnologyDatabase } from './database.js';

interface DetectionState {
  confidence: number;
  version: string;
}

/**
 * Resolve technology relationships after initial detection.
 *
 * Processing order:
 * 1. Implies: if A detected, add implied technologies with optional confidence
 * 2. Requires: remove A if its required technology B is not detected
 * 3. RequiresCategory: remove A if no technology in the required category is detected
 * 4. Excludes: if A and B both detected and A excludes B, remove B
 */
export function resolveRelationships(
  detections: Map<string, DetectionState>,
  database: TechnologyDatabase,
): Map<string, DetectionState> {
  const resolved = new Map(detections);

  // --- 1. Implies ---
  // Process in rounds until no new technologies are added (handles transitive implies)
  let changed = true;
  const maxRounds = 10;
  let round = 0;

  while (changed && round < maxRounds) {
    changed = false;
    round++;

    for (const [name, state] of Array.from(resolved.entries())) {
      if (state.confidence <= 0) continue;

      const tech = database.getByName(name);
      if (!tech?.implies) continue;

      for (const implied of tech.implies) {
        const existing = resolved.get(implied.name);
        const impliedConfidence = Math.min(100, Math.round(
          state.confidence * (implied.confidence / 100),
        ));

        if (impliedConfidence <= 0) continue;

        if (!existing) {
          resolved.set(implied.name, { confidence: impliedConfidence, version: '' });
          changed = true;
        } else if (existing.confidence < impliedConfidence) {
          existing.confidence = impliedConfidence;
          changed = true;
        }
      }
    }
  }

  // --- 2. Requires ---
  for (const [name] of Array.from(resolved.entries())) {
    const tech = database.getByName(name);
    if (!tech?.requires) continue;

    const allMet = tech.requires.every((req) => {
      const dep = resolved.get(req);
      return dep && dep.confidence > 0;
    });

    if (!allMet) {
      resolved.delete(name);
    }
  }

  // --- 3. RequiresCategory ---
  for (const [name] of Array.from(resolved.entries())) {
    const tech = database.getByName(name);
    if (!tech?.requiresCategory) continue;

    const categoryMet = tech.requiresCategory.every((catId) => {
      // Check if any detected technology belongs to this category
      for (const [detName, detState] of resolved) {
        if (detState.confidence <= 0) continue;
        const detTech = database.getByName(detName);
        if (detTech?.cats.includes(catId)) return true;
      }
      return false;
    });

    if (!categoryMet) {
      resolved.delete(name);
    }
  }

  // --- 4. Excludes ---
  const toRemove: string[] = [];

  for (const [name, state] of resolved) {
    if (state.confidence <= 0) continue;

    const tech = database.getByName(name);
    if (!tech?.excludes) continue;

    for (const excluded of tech.excludes) {
      if (resolved.has(excluded)) {
        // The excluded tech is removed (the excluder wins)
        toRemove.push(excluded);
      }
    }
  }

  for (const name of toRemove) {
    resolved.delete(name);
  }

  // Filter out zero-confidence results
  for (const [name, state] of resolved) {
    if (state.confidence <= 0) resolved.delete(name);
  }

  return resolved;
}
