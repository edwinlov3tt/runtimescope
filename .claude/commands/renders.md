---
description: Render performance audit — find excessive re-renders and suggest fixes
allowed-tools: ["Bash", "Read", "Grep", "Glob"]
---

# Renders — Component Render Audit

Analyze React/Vue/Svelte component render performance. Find excessive re-renders, flag suspicious components, and suggest optimization fixes.

**Usage**: `/renders $ARGUMENTS`

**Examples**:
- `/renders` — audit all components
- `/renders ProductList` — focus on a specific component
- `/renders slow` — only show components with high render counts

**Requires**: RuntimeScope SDK connected with `captureRenders: true` in config. React dev mode recommended for timing data.

---

## Phase 1: Check Render Data

Use `get_render_profile` to get render data. If `$ARGUMENTS` is provided, pass it as `component_name` filter.

If no render data is available:

```markdown
No render data captured. To enable render tracking:

1. Ensure your app runs in **development mode** (React DevTools must be active)
2. Add `captureRenders: true` to your RuntimeScope config:
   ```js
   RuntimeScope.init({
     appName: 'my-app',
     captureRenders: true,
   });
   ```
3. Reload your app and interact with it, then run `/renders` again.
```

---

## Phase 2: Analyze Render Profiles

From the render profile data, identify:

1. **Excessive re-renders**: Components rendering >10x in a short window
2. **Slow renders**: Components with average render duration >16ms (drops below 60fps)
3. **Cascade renders**: Parent renders causing unnecessary child re-renders
4. **Render velocity**: Components with high renders-per-second

---

## Phase 3: Report

```markdown
# Render Performance Audit

**Components tracked**: X | **Total renders**: X | **Time window**: Xs

## Flagged Components

### Critical (renders >50x or >16ms avg)
| Component | Renders | Avg Duration | Velocity | Cause |
|-----------|---------|-------------|----------|-------|
| ProductList | 147 | 23ms | 12/s | props change on every parent render |

### Warning (renders >20x or >8ms avg)
| Component | Renders | Avg Duration | Velocity | Cause |
|-----------|---------|-------------|----------|-------|

### Healthy
| Component | Renders | Avg Duration |
|-----------|---------|-------------|

## Recommendations

### 1. [Component Name] — X renders
**Problem**: [Why it's re-rendering excessively]
**Fix**:
```jsx
// Wrap with React.memo to prevent re-renders from parent
const ProductList = React.memo(function ProductList({ items }) {
  // ...
});

// Or use useMemo for expensive computations
const sortedItems = useMemo(() => items.sort(...), [items]);
```

### 2. [Component Name] — Xms avg render
**Problem**: [Why it's slow]
**Fix**: [Specific optimization — virtualization, memoization, etc.]
```

---

## Phase 4: Code-Level Suggestions

If specific components are flagged, search the codebase for them:

- Look for missing `React.memo`, `useMemo`, `useCallback`
- Check if props are being recreated on every render (inline objects/arrays)
- Look for state updates in render or useEffect without proper deps
- Suggest specific code changes with file paths and line numbers
