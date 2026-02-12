# RuntimeScope — Design System & UI Specification

> Reverse-engineered from Limelight application screenshots, adapted and elevated for RuntimeScope's broader feature set. This document provides everything a developer needs to rebuild the visual system.

---

## A. Visual DNA Summary

Limelight is a developer-focused desktop tool built around a **dark ambient aesthetic** — not the flat gray-on-black of most dev tools, but a layered system with subtle depth. The app uses a narrow dark sidebar as a persistent frame, with the main content area living inside a slightly lighter, rounded container that floats within that frame. This creates a "window within a window" effect that feels premium without being decorative. The color language is restrained: a near-black background, a dark slate content surface, muted text by default, with color used surgically — teal/cyan for status badges, purple/violet for props-related data, amber/orange for warnings, red for critical issues, and green for healthy/connected states. Typography is a system monospace-adjacent sans-serif (likely Inter or SF Pro) at small sizes with generous letter-spacing in labels. The information density is high but never cluttered — achieved through consistent spacing rhythms, subtle dividers, and a clear hierarchy of surface → panel → card → inline element. The overall impression is "a tool built by someone who uses Figma and cares about the craft" rather than "a tool with a UI bolted on."

**For RuntimeScope, we keep this DNA but evolve it:** slightly warmer neutral tones (not pure blue-black), more generous whitespace in the expanded feature areas (database, API map), and a more distinctive accent palette that differentiates us from the Limelight/Warp/Linear dark-tool monoculture.

---

## B. Design Tokens

### Colors

#### Background Layers (darkest → lightest)

| Token | Hex | Usage |
|-------|-----|-------|
| `--bg-app` | `#0A0A0F` | Outermost app frame, sidebar background, the "void" |
| `--bg-surface` | `#111118` | Main content container background |
| `--bg-elevated` | `#1A1A24` | Cards, panels, detail drawers, popovers |
| `--bg-hover` | `#22222E` | Row hover state, interactive surface hover |
| `--bg-active` | `#2A2A38` | Active/selected row, pressed state |
| `--bg-input` | `#16161F` | Search inputs, form fields, filter bars |
| `--bg-tooltip` | `#1E1E2A` | Tooltip backgrounds with border |

#### Text Hierarchy

| Token | Hex | Usage |
|-------|-----|-------|
| `--text-primary` | `#E8E8ED` | Primary text, headings, values |
| `--text-secondary` | `#9898A6` | Secondary labels, descriptions, meta text |
| `--text-tertiary` | `#5E5E6E` | Placeholder text, disabled text, timestamps |
| `--text-inverse` | `#0A0A0F` | Text on colored badges |

#### Borders & Dividers

| Token | Hex | Usage |
|-------|-----|-------|
| `--border-subtle` | `#1E1E2A` | Card borders, panel separators (barely visible) |
| `--border-default` | `#2A2A38` | Input borders, table row dividers |
| `--border-strong` | `#3A3A4A` | Focus rings, active borders |

#### Accent Colors (Status & Data)

| Token | Hex | Usage | Limelight Equivalent |
|-------|-----|-------|---------------------|
| `--accent-brand` | `#6366F1` | Primary brand, selected nav items, primary buttons | Sidebar active highlight |
| `--accent-brand-subtle` | `#6366F120` | Brand tint backgrounds | Nav item active bg |
| `--color-green` | `#22C55E` | Connected, healthy, success, "State" cause | ● Connected badge, green dots |
| `--color-green-subtle` | `#22C55E20` | Green badge backgrounds | Status pill bg |
| `--color-blue` | `#3B82F6` | Props cause, info badges, links | ● Props dot |
| `--color-blue-subtle` | `#3B82F620` | Blue badge backgrounds | "memo" badge bg |
| `--color-purple` | `#A855F7` | GraphQL badges, component type indicators | Network method badges |
| `--color-purple-subtle` | `#A855F720` | Purple badge backgrounds | — |
| `--color-amber` | `#F59E0B` | Warnings, Context cause, moderate speed | ● Context dot, warning badges |
| `--color-amber-subtle` | `#F59E0B20` | Warning backgrounds | — |
| `--color-red` | `#EF4444` | Errors, critical issues, Parent cause, failed requests | ● critical badge, 404 status |
| `--color-red-subtle` | `#EF444420` | Error backgrounds | "Render loop" badge bg |
| `--color-orange` | `#F97316` | Force cause, "Unstable props" badge, ref-only marker | ● Force dot, orange badges |
| `--color-orange-subtle` | `#F9731620` | Orange badge backgrounds | — |
| `--color-cyan` | `#06B6D4` | Status codes (200), connected indicator | Teal 200 badges |
| `--color-gray` | `#6B7280` | Unknown cause, neutral badges | ● Unknown dot |

#### Chart Colors

| Token | Hex | Usage |
|-------|-----|-------|
| `--chart-line` | `#A855F7` | Primary chart line (renders over time) |
| `--chart-fill` | `#A855F710` | Area fill under chart line |
| `--chart-request` | `#3B82F6` | Request dots in scatter |
| `--chart-log` | `#F59E0B` | Log dots in scatter |
| `--chart-render` | `#22C55E` | Render dots in scatter |
| `--chart-grid` | `#1E1E2A` | Grid lines, axis lines |
| `--chart-label` | `#5E5E6E` | Axis labels, tick marks |

### Typography

#### Font Stack

```css
--font-sans: 'Inter', 'SF Pro Display', -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
--font-mono: 'JetBrains Mono', 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
```

#### Type Scale

| Token | Size | Weight | Line Height | Letter Spacing | Usage |
|-------|------|--------|-------------|----------------|-------|
| `--text-xs` | 11px | 400/500 | 16px | 0.02em | Timestamps, axis labels, tertiary meta |
| `--text-sm` | 13px | 400/500 | 18px | 0.01em | Table cells, descriptions, badge text, most body text |
| `--text-base` | 14px | 400/500 | 20px | 0 | Primary body text, input values |
| `--text-md` | 15px | 500/600 | 22px | -0.01em | Section headings, panel titles, nav items |
| `--text-lg` | 18px | 600 | 26px | -0.02em | Page/tab titles, detail panel heading |
| `--text-xl` | 24px | 700 | 32px | -0.03em | Hero metrics (95% Props, render count) |
| `--text-2xl` | 32px | 700 | 40px | -0.03em | Large stat numbers (Depth: 2, Fields: 8) |
| `--text-mono-sm` | 12px | 400 | 18px | 0 | Code snippets, JSON, header values, SQL |
| `--text-mono-base` | 13px | 400 | 20px | 0 | Code blocks, prop diffs, function signatures |

#### Typography Rules

- **Headings** (panel titles, section headers): `--text-md` to `--text-lg`, weight 500-600, `--text-primary`
- **Body text** (descriptions, explanations): `--text-sm`, weight 400, `--text-secondary`
- **Table cells**: `--text-sm`, weight 400, `--text-primary` for values, `--text-secondary` for labels
- **Badges/pills**: `--text-xs`, weight 500, uppercase NOT used (Limelight uses normal case)
- **Code/monospace**: `--text-mono-sm`, `--text-secondary` for keys, `--text-primary` for values
- **Numbers/metrics**: `--text-xl` to `--text-2xl`, weight 700, `--text-primary`
- **Timestamps**: `--text-xs`, weight 400, `--text-tertiary`, right-aligned

### Spacing Scale

Based on an 4px base unit:

| Token | Value | Usage |
|-------|-------|-------|
| `--space-0` | 0px | — |
| `--space-1` | 4px | Inline badge padding, icon-to-text gap |
| `--space-2` | 8px | Inner badge padding, tight group gaps |
| `--space-3` | 12px | Input padding, small card padding, table cell padding |
| `--space-4` | 16px | Standard component padding, section gaps |
| `--space-5` | 20px | Panel padding, major section gaps |
| `--space-6` | 24px | Panel-to-panel gaps, content area padding |
| `--space-8` | 32px | Page-level padding, major layout gaps |
| `--space-10` | 40px | Large section dividers |
| `--space-12` | 48px | Sidebar width-to-content gap equivalent |

#### Layout Grid

| Token | Value | Usage |
|-------|-------|-------|
| `--sidebar-width` | 200px | Left navigation sidebar |
| `--sidebar-collapsed` | 52px | Collapsed sidebar (icon-only) |
| `--shell-padding` | 8px | Gap between sidebar and content container (the "frame") |
| `--content-radius` | 12px | Content container border radius |
| `--panel-max-width` | 380px | Right detail/insights panel width |
| `--topbar-height` | 44px | Sub-navigation bar (tabs + filters) |
| `--filter-bar-height` | 40px | Search/filter row below topbar |

### Radius & Elevation

| Token | Value | Usage |
|-------|-------|-------|
| `--radius-sm` | 4px | Badges, small pills, inline tags |
| `--radius-md` | 6px | Buttons, inputs, table cells |
| `--radius-lg` | 8px | Cards, panels, popovers, tooltips |
| `--radius-xl` | 12px | Main content container, modals |
| `--radius-full` | 9999px | Status dots, circular badges, avatars |

| Elevation | Value | Usage |
|-----------|-------|-------|
| `--shadow-none` | none | Most surfaces (depth comes from bg color layers) |
| `--shadow-sm` | `0 1px 2px rgba(0,0,0,0.3)` | Subtle lift for popovers |
| `--shadow-md` | `0 4px 12px rgba(0,0,0,0.4)` | Tooltips, dropdown menus |
| `--shadow-lg` | `0 8px 24px rgba(0,0,0,0.5)` | Modals, detail panels on mobile |
| `--shadow-glow` | `0 0 12px rgba(99,102,241,0.15)` | Subtle brand glow on focus states |

**Key insight from Limelight**: Depth is achieved primarily through **background color layering**, not box-shadows. The sidebar is `--bg-app`, the content container is `--bg-surface`, panels within it are `--bg-elevated`. Shadows are reserved for floating elements only (tooltips, popovers, modals).

---

## C. Component Spec

### C.1 App Shell — The "Floating Content" Pattern

This is the signature layout pattern visible in every screenshot. The content area is a rounded rectangle that floats within the darker sidebar/frame.

```
┌─────────────────────────────────────────────────────────┐
│ bg-app (the void/frame)                                 │
│ ┌──────────┐ ┌────────────────────────────────────────┐ │
│ │          │ │ bg-surface (rounded content container)  │ │
│ │ Sidebar  │ │                                         │ │
│ │ bg-app   │ │  ┌─ Topbar ─────────────────────────┐  │ │
│ │          │ │  │ Tab navigation + filters          │  │ │
│ │  ● Issues│ │  └──────────────────────────────────┘  │ │
│ │  ● Netwk │ │                                         │ │
│ │  ● Consol│ │  ┌─ Content ────────────────────────┐  │ │
│ │  ● Render│ │  │                                   │  │ │
│ │  ● State │ │  │  Main data area                   │  │ │
│ │          │ │  │  (table / chart / list)            │  │ │
│ │ Settings │ │  │                                   │  │ │
│ │  ● Gener │ │  └──────────────────────────────────┘  │ │
│ │          │ │                                         │ │
│ └──────────┘ └────────────────────────────────────────┘ │
│                                                         │
│  ↑ 8px gap   ↑ 12px radius on content container         │
└─────────────────────────────────────────────────────────┘
```

**Implementation:**

```tsx
// AppShell.tsx
<div className="h-screen w-screen bg-[--bg-app] flex p-0">
  {/* Sidebar — flush to edges, no padding */}
  <Sidebar className="w-[200px] shrink-0" />

  {/* Content container — the floating rounded panel */}
  <main className="flex-1 m-2 ml-0 rounded-xl bg-[--bg-surface] overflow-hidden flex flex-col">
    <Topbar />
    <FilterBar />
    <ContentArea />
  </main>
</div>
```

**Critical detail**: The `m-2 ml-0` on the content container creates the 8px gap on top, right, and bottom, but zero on the left (sidebar is already providing the visual separation). The rounded corners (`rounded-xl` = 12px) only appear on the content container — the sidebar itself has no rounded corners since it's flush to the window edge.

On macOS, the traffic lights (close/minimize/maximize) sit in the sidebar header area, which has extra top padding (~28px) to accommodate them.

### C.2 Sidebar

**Anatomy:**

```
┌─────────────────┐
│ ● ● ●           │  ← macOS traffic lights (28px top padding)
│                  │
│ [Logo] Limelight │  ← App name + logo + dropdown chevron
│         ▾        │
│                  │
│ General          │  ← Section label (text-xs, text-tertiary, uppercase tracking)
│  ◉ Issues        │  ← Nav item: icon + label
│  ○ Network       │
│  ○ Console       │
│  ◉ Renders       │  ← Active: bg highlight + brand color text
│  ○ State         │
│                  │
│ Settings         │  ← Section label
│  ○ General       │
│                  │
│                  │
│                  │  ← Flex spacer pushes settings to bottom area
└─────────────────┘
```

**Nav Item States:**

| State | Background | Text | Icon |
|-------|-----------|------|------|
| Default | transparent | `--text-secondary` | `--text-secondary`, 18px, stroke 1.5 |
| Hover | `--bg-hover` | `--text-primary` | `--text-primary` |
| Active | `--accent-brand-subtle` | `--accent-brand` | `--accent-brand` |
| Active (RuntimeScope) | `--accent-brand-subtle` with left 2px solid `--accent-brand` border | `--text-primary` | `--accent-brand` |

**Specs:**
- Nav item height: 36px
- Nav item padding: 12px horizontal, 8px vertical
- Icon size: 18px (outline style, stroke-width 1.5)
- Icon-to-label gap: 10px
- Section label: 11px, weight 500, `--text-tertiary`, 8px left padding, 16px top margin
- Active indicator: subtle background tint (Limelight uses a filled bg on the full row)

### C.3 Topbar (Sub-Navigation)

The bar immediately inside the content container. Contains tab-level navigation and global actions.

**Anatomy (from Network screenshots):**

```
┌──────────────────────────────────────────────────────────┐
│  Network    ⊞ Table    ≡ Timeline         ● Connected    │
│                                                          │
│  ☰ Filter   [Component Type] [is] [Memoized] ✕          │
│                                                          │
│  🔍 contains [render...]                                  │
└──────────────────────────────────────────────────────────┘
```

Three rows observed:
1. **Tab row** (44px): View mode tabs (Renders/Actionable/All or Network/Table/Timeline) + right-aligned status badge
2. **Filter row** (36px): Active filter pills with operator dropdowns
3. **Search row** (40px): Search input with "contains" prefix badge

**Tab Styles:**

| State | Text | Border | Background |
|-------|------|--------|-----------|
| Default | `--text-secondary` | none | transparent |
| Hover | `--text-primary` | none | `--bg-hover` |
| Active | `--text-primary` | bottom 2px `--accent-brand` | transparent |

**Status Badge (top-right):**
- "Connected": Green dot (8px) + text "Connected" in `--color-green`, `--text-sm`
- "Paused": Orange/red dot + text "Paused" in `--color-orange`
- Border: 1px solid `--border-default`, radius `--radius-full`, padding 6px 12px

### C.4 Data Table

The primary data display pattern used in Network, Renders list, Console, and Query views.

**Anatomy (from Network table - Image 6):**

```
┌──────────┬──────────┬────────┬────────────────────────┐
│ Name     │ Status   │ Method │ URL                    │  ← Header row
├──────────┼──────────┼────────┼────────────────────────┤
│ graphql  │ ● 200    │ ● POST │ /grap...               │  ← Data row
│ graphql  │ ● 200    │ ● POST │ /grap...               │  ← Selected row
│ symboli..│ ● 200    │ ● POST │ /symb...               │
│ invalid..│ ● 404    │ ● GET  │ /inva...               │  ← Error row
│ posts    │ ● 201    │ ● POST │ /post...               │
└──────────┴──────────┴────────┴────────────────────────┘
```

**Specs:**

| Property | Value |
|----------|-------|
| Header row height | 36px |
| Data row height | 40px |
| Cell padding | 12px horizontal |
| Header text | `--text-xs`, weight 500, `--text-tertiary`, uppercase |
| Cell text | `--text-sm`, weight 400, `--text-primary` |
| Row divider | 1px solid `--border-subtle` |
| Selected row bg | `--bg-active` |
| Hover row bg | `--bg-hover` |
| Sticky header | yes, bg `--bg-surface` |
| Alternating rows | NO (Limelight uses uniform bg) |

**Status code badges:** Inline colored dots (6px circle) + number. 200/201 = `--color-cyan`, 404 = `--color-red`, 500 = `--color-red` (brighter).

**Method badges:** Small pill with colored dot + text. GET = `--color-green`, POST = `--color-purple`, PUT = `--color-amber`, DELETE = `--color-red`.

**Renders List variant (from Image 5, 10):**

```
│ 41x │ ⚡ MemoizedButton               │  ← render count + icon + name
│     │                                  │
│     │ ● info   ● High render rate  ● 45  0.0ms │  ← severity + issue + score + time
```

The renders table is simpler — no traditional columns, more of a list with inline metadata:
- Left: render count as bold number (`--text-sm`, weight 600)
- Icon: component type indicator (⚡ for function, 🔧 for class, 😊 for memo, etc.)
- Name: component name (`--text-sm`, weight 500, `--text-primary`)
- Right-aligned badges: severity pill + issue description pill + render score + render time

### C.5 Detail Panel (Right Drawer)

Slides in from the right when a row is selected. ~380px wide. Has two tabs: Details and Insights.

**Anatomy (from Images 4, 5, 7, 8, 11):**

```
┌─────────────────────────────────────┐
│  🔧 Details    ✨ Insights           │  ← Tab selector
├─────────────────────────────────────┤
│  Details >                     ✕    │  ← Panel title + close button
│                                     │
│  ● 200  ● POST  [GraphQL]          │  ← Status badges row
│                                     │
│  https://rickandmortyapi.com/gra... │  ← URL (text-sm, mono)
│  Duration: 429ms                    │  ← Key-value pairs
│  Size: 263 bytes                    │
│                                     │
│  ┌─────┬────────┬───────┬────┬────┐│
│  │Req. │Response│Headers│Prev│Time││  ← Sub-tabs
│  └─────┴────────┴───────┴────┴────┘│
│                                     │
│  Headers                        📋  │  ← Section with copy button
│  {                                  │
│    "accept": "application/graph..." │  ← Mono code block
│    "content-type": "application/j.."│
│  }                                  │
│                                     │
│  Query Health                       │  ← Section heading
│  ● Low                              │  ← Health badge (green)
│  Score: 16                          │
│  Simple query, fast execution       │
│                                     │
│  Depth    Fields    Fragments       │  ← Stat grid
│   2         8          0            │  ← Large numbers (text-2xl)
│                                     │
│  Operation                          │
│  GetCharacter                       │  ← Mono text
│                                     │
│  Variables                      📋  │
│  {                                  │
│    id: "1"                          │
│  }                                  │
└─────────────────────────────────────┘
```

**Panel Specs:**

| Property | Value |
|----------|-------|
| Width | 380px (fixed, not resizable in Limelight) |
| Background | `--bg-elevated` |
| Left border | 1px solid `--border-subtle` |
| Padding | 20px |
| Close button | 24px ✕ icon, `--text-tertiary`, hover `--text-primary` |
| Tab underline | 2px bottom border `--accent-brand` on active |
| Section heading | `--text-md`, weight 600, `--text-primary` |
| Section gap | 20px between sections |
| Code block bg | `--bg-input` with 1px `--border-subtle`, radius `--radius-md`, 12px padding |
| Copy button | 18px clipboard icon, top-right of section, `--text-tertiary` |

**Insights Tab (from Images 4, 6, 9):**

Shows related events correlated to the selected item. Contains:
- List of related components/logs with relevance score (colored dot + number)
- "View all related activity (N)" link
- Scatter plot showing requests/logs/renders positioned by time (X axis, relative to event) and relevance score (Y axis)

Scatter plot specs:
- Axes: X = time relative to event (e.g., -4.4s to +1.5s), Y = relevance score (0-100)
- Dots: 10px circles, colored by type (blue=requests, orange=logs, green=renders)
- Grid: subtle dashed lines at 25/50/75/100 on Y
- "This event" marker: vertical dashed line at X=0
- Legend: bottom, horizontal, small colored dots + labels

### C.6 Render Diagnosis Panel (from Image 5)

A specialized detail panel for render issues. Key unique components:

**Diagnosis Card:**
```
┌─────────────────────────────────────┐
│  🔧 Diagnosis                       │
│                                     │
│  Cause:       Memo ineffective      │
│  Details:     'onPress', 'style'    │
│               changing every render │
│               (same value, new ref) │
│  Suggestions: Wrap 'onPress' in     │
│               useCallback. Wrap     │
│               'style' in useMemo    │
│               or StyleSheet.        │
└─────────────────────────────────────┘
```

Key-value layout: label left-aligned in `--text-secondary`, value right-aligned in `--text-primary`. Generous row height (~28px per row).

**"Why it renders" Stat:**
```
┌─────────────────────────────────────┐
│  Why it renders                     │
│                                     │
│        95%  Props                   │  ← Large number (text-xl, bold)
│      39 of 41 renders               │  ← Subtext (text-xs, secondary)
│                                     │
│  ● Unknown 5%                       │  ← Small pie or bar + label
└─────────────────────────────────────┘
```

**Prop Changes Diff:**
```
┌─────────────────────────────────────┐
│  Prop changes                       │
│  ⊘ Unstable references (2)         │  ← Warning icon + count
│                                     │
│  onPress  39×                       │
│  ┌─ 1   () => handlePress()     ┐  │  ← Old value (dimmed row)
│  ├─ 2   () => handlePress()     ┤  │  ← New value (highlighted, red bg)
│  │      [New reference]          │  │  ← Inline badge
│  └──────────────────────────────┘  │
│                                     │
│  style  39×                         │
│  ┌─ 1   { ... }                 ┐  │
│  ├─ 2   { ... }  [New reference]┤  │
│  └──────────────────────────────┘  │
└─────────────────────────────────────┘
```

Diff highlighting:
- Row 1 (old): `--bg-surface`, `--text-secondary`
- Row 2 (new): `--color-red-subtle` background, number badge in `--color-red`
- "New reference" label: `--color-red`, inline, `--text-xs`

### C.7 Render Timeline Chart (from Images 1, 2, 3)

An area chart showing render count over time with hover tooltips.

**Specs:**
- Chart type: Area chart with smooth curve (cubic bezier interpolation)
- Line color: `--chart-line` (purple/violet)
- Fill: Gradient from `--chart-line` at ~15% opacity at top → transparent at bottom
- Background: `--bg-surface` (the chart area blends into the panel)
- X-axis: Time, labels in `--text-xs`, `--chart-label`
- Y-axis: Not explicitly labeled (implied by hover values)
- Grid: Subtle horizontal lines in `--chart-grid`

**Hover Tooltip (from Image 2):**
```
┌──────────────────────┐
│  1                    │  ← Bucket index
│  28 renders           │  ← Bold number
│  ● Props     28       │  ← Cause breakdown
│                       │
│  Top contributors:    │
│  Pressable    24×     │
│  MemoizedButton 4×    │
└──────────────────────┘
```
- Background: `--bg-elevated`
- Border: 1px `--border-default`
- Radius: `--radius-lg`
- Padding: 12px
- Shadow: `--shadow-md`
- Pointer: small triangle/arrow pointing to data point

### C.8 Badges & Pills

Multiple badge variants observed:

**Status Badge (connection):**
- Dot (8px) + text, border 1px, radius full
- Green: `--color-green` dot + text, `--color-green-subtle` border
- Orange: `--color-orange` dot + text

**Method Badge:**
- Small colored dot (6px) + method text in colored pill
- GET: green, POST: purple, PUT: amber, DELETE: red
- Background: color at 15% opacity, text in full color
- Padding: 4px 8px, radius: `--radius-sm`

**Issue/Severity Badge:**
- `info`: `--color-green` dot + "info" text on transparent bg
- `critical`: `--color-red` text on `--color-red-subtle` bg
- `memo`: `--color-blue` text on `--color-blue-subtle` bg
- `Render loop`: `--color-red` text on `--color-red-subtle` bg
- `High render rate`: `--color-amber` text on `--color-amber-subtle` bg
- `Unstable props`: `--color-orange` text on `--color-orange-subtle` bg

**Render Score Badge:**
- Colored dot (8px, color based on severity) + number
- Layout: inline, no background, just dot + text

**Cause Legend Items (right panel):**
- Clickable pills with colored dot + label
- State: green, Props: blue, Context: amber, Parent: red, Force: orange, Unknown: gray
- Padding: 6px 10px, border: 1px `--border-default`, radius: `--radius-md`
- Act as toggleable filters

### C.9 Filter Bar

**Filter Pill:**
```
[Component Type] [is] [Memoized] ✕
```
- Background: `--bg-input`
- Border: 1px `--border-default`
- Radius: `--radius-md`
- Each segment is a separate clickable area (dropdown)
- ✕ close button: `--text-tertiary`, hover `--text-primary`

**Search Input:**
```
🔍 [contains ▾] [render...                    ]
```
- Left icon: search, `--text-tertiary`, 16px
- "contains" prefix: badge-style, `--bg-elevated`, `--text-secondary`
- Input field: `--bg-input`, `--text-primary`, placeholder in `--text-tertiary`
- Full width below filter pills
- Height: 36px
- Border: 1px `--border-default`, radius `--radius-md`
- Focus: border `--border-strong`, subtle `--shadow-glow`

### C.10 Summary Stats Bar (from Image 5, 10)

```
Components 91 │ Renders 3423 │ Cost 13.8ms │ Actionable 23 │ Noise (grouped) 24
```

- Layout: horizontal, separated by thin vertical dividers
- Label: `--text-xs`, `--text-tertiary`
- Value: `--text-xs`, weight 600, `--text-primary`
- Divider: 1px `--border-subtle`, 12px height
- Position: just below the filter/search area, above the table

### C.11 Causes Breakdown Bar (from Images 1, 2, 3)

A stacked horizontal bar showing render cause distribution:

```
Causes                                            100% Props
████████████████████████████████████████████████████████████
● Props: 595 (100%)
```

- Bar height: 8px
- Bar radius: `--radius-full`
- Colors: State=green, Props=blue, Context=amber, Parent=red, Force=orange, Unknown=gray
- Label below: colored dot + "Category: N (X%)" in `--text-sm`
- Section heading: `--text-sm`, weight 500, `--text-secondary` on left, percentage on right

### C.12 Top Offenders List (from Images 1, 2, 3)

```
● Pressable    ● Unstable props                510×  >
● MemoizedButton  ● Unstable props              85×  ▾
```

- Layout: list items, clickable/expandable
- Left: colored dot (component type indicator) + component name in bold
- Middle: issue badges
- Right: render count + expand chevron
- Row height: 40px
- Hover: `--bg-hover`
- Expanded: shows detailed breakdown below the row

### C.13 Metric Grid (from Image 8)

For displaying key stats in a 3-column grid:

```
Depth     Fields     Fragments
  2          8           0
```

- Layout: CSS Grid, 3 equal columns
- Label: `--text-sm`, weight 400, `--text-secondary`, above
- Value: `--text-2xl`, weight 700, `--text-primary`, below
- Gap: 16px between items

### C.14 View Toggle (from Image 3)

A popover/dropdown with icon options for switching between List and Timeline views:

```
┌─────────────────────┐
│  ☰ List  │ ≡ Timeline │
└─────────────────────┘
```

- Background: `--bg-elevated`
- Border: 1px `--border-default`
- Radius: `--radius-lg`
- Active: `--bg-active` background, `--text-primary` text
- Inactive: transparent, `--text-secondary`
- Shadow: `--shadow-md`

### C.15 Buttons

Observed button variants:

| Variant | Background | Text | Border | Hover |
|---------|-----------|------|--------|-------|
| Ghost (primary) | transparent | `--text-secondary` | none | `--bg-hover`, `--text-primary` |
| Ghost (icon) | transparent | `--text-tertiary` | none | `--bg-hover`, `--text-secondary` |
| Outline | transparent | `--text-secondary` | 1px `--border-default` | `--bg-hover` |
| Display/Clear buttons | transparent | `--text-secondary` | none | text `--text-primary` |

Limelight is very restrained with buttons — most actions are ghost/text style. No primary filled buttons observed in the data views.

**For RuntimeScope additions:**
- **Primary**: `--accent-brand` bg, white text, hover darken 10%
- **Danger**: `--color-red` bg, white text, for destructive actions (kill process, delete)
- **Success**: `--color-green` bg, white text, for connection/save confirmations

---

## D. Behavior Spec

### Navigation & Layout

- Sidebar nav items navigate between main tabs. Active tab is highlighted with brand accent
- Content container scrolls independently of sidebar (sidebar is fixed)
- Topbar tabs switch sub-views within the current tab (e.g., Network > Table | Timeline)
- Filter bar is sticky below topbar; scrolls with content only if there's overflow
- Detail panel opens from right, pushing or overlaying the main content (ASSUMPTION: overlays based on screenshots showing full-width tables behind)

### Table Interactions

- **Click row** → Opens detail panel on right with Details tab active
- **Hover row** → Row background transitions to `--bg-hover` with 150ms ease
- **Selected row** → Row background is `--bg-active`, persists until another row is clicked or panel is closed
- **Header click** → Sorts column ascending/descending (toggle). Sort indicator: small chevron in header
- **Table is virtualized** → Only visible rows are rendered. Smooth scroll, no pagination (infinite scroll with buffer)
- **No bulk actions observed** → Single-select only

### Detail Panel

- **Tab toggle** → Switches between Details and Insights. No animation, instant swap
- **Close (✕)** → Panel slides out, selected row deselects
- **Sub-tabs (Request/Response/Headers/Preview/Timing)** → Switch content within the panel. Active tab has bottom border
- **Copy buttons (📋)** → Copies section content to clipboard. Brief "Copied!" tooltip feedback
- **Expandable JSON** → Click to expand/collapse nested objects. Chevron indicator
- **Links** → "View all related activity (10)" link scrolls to or opens a filtered view

### Chart Interactions

- **Hover on chart** → Tooltip appears near cursor showing render count, cause breakdown, top contributors
- **Chart is responsive** → Resizes with panel width
- **Pause/Resume** → Top-right status badge toggles data streaming. Paused = chart stops updating
- **Render cause legend items** → Clickable to toggle visibility of that cause in the chart (ASSUMPTION based on the toggle-like styling)

### Filtering

- **Search input** → Real-time filter as you type (debounced ~200ms). Filters table/list rows
- **"contains" dropdown** → Changes search mode (contains, equals, starts with, regex)
- **Filter pills** → Structured filters. Each pill has dropdown segments. ✕ removes the filter
- **✕ Clear (top-right)** → Removes all active filters and search text

### Render-Specific

- **Component list item click** → Opens render diagnosis panel on right
- **Expand (▾) on Top Offender** → Expands inline to show CAUSE BREAKDOWN bar and CHANGING PROPS details
- **Render count badges** → Color indicates severity. Low count = gray/green, high = amber/red
- **"Actionable" tab filter** → Shows only components where optimization would have real impact (removes noise)

### Loading & Streaming

- **Real-time data** → New events appear at top of table/list with subtle fade-in animation (opacity 0 → 1 over 200ms)
- **No skeleton screens observed** → Empty states likely show a centered message/illustration
- **Connected indicator** → Live dot pulses subtly when actively receiving data
- **Paused state** → Data buffer continues collecting but UI doesn't update. Resume loads buffered data

### Process Monitor (RuntimeScope-specific)

- **Kill button** → Confirmation dialog before terminating: "Kill Next.js dev server on :3000?" with Cancel/Confirm
- **Open in browser [↗]** → Opens `http://localhost:{port}` in default browser
- **Project name click** → Opens project directory in system file manager
- **Memory warning** → Row background tints to `--color-amber-subtle` when >500MB, `--color-red-subtle` when >1GB
- **Orphan detection** → Stale processes get a pulsing amber dot after 30min of inactivity

---

## E. Inferred Sitemap & Screen Blueprints

### Confirmed Screens (from screenshots)

| Screen | Evidence |
|--------|----------|
| Network > Table | Images 6, 7 |
| Network > Timeline | Tab visible in Image 6 (not shown active) |
| Console | Nav item visible, not screenshot'd |
| Renders > List (All) | Images 5, 10 |
| Renders > Actionable | Tab visible in Image 5 |
| Renders > Timeline | Images 1, 2, 3 |
| State | Nav item visible, not screenshot'd |
| Issues | Nav item visible, not screenshot'd |
| Settings > General | Nav item visible, not screenshot'd |

### Inferred Screens (ASSUMPTIONS)

#### Issues Tab
**ASSUMPTION**: The Issues tab aggregates all detected problems into a prioritized list, similar to a linter output.

Layout: Reuses the data table component with columns for Severity (badge), Issue Type (text + badge), Component/Endpoint (text), Count (number), and Last Seen (timestamp). Detail panel shows the full diagnosis with evidence + suggestion, reusing the Diagnosis Card component from Renders.

**Why this assumption**: Issues is the first item in the sidebar (highest priority position), and the issue badge system (critical, info, render loop, high render rate) is already fully built out in the renders view. It would be inconsistent to NOT have a unified issues view.

#### Console Tab
**ASSUMPTION**: A streaming log viewer with level-based color coding and expandable stack traces.

Layout: Single column list (not a multi-column table). Each row shows: level icon (colored), timestamp, message text (truncated), and expand chevron. Expanded view shows full message + JSON args viewer + stack trace. Filter bar filters by level (log/warn/error/info/debug). Search works on message text.

**Why this assumption**: The Insights panel already shows console log entries (Image 9) with the format: `log: "🔵 Starting GraphQL Query with variables"` — indicating structured log display with emoji/color indicators.

#### State Tab
**ASSUMPTION**: Two-pane layout. Left: list of stores with mutation count and frequency. Right: current state tree viewer (collapsible JSON) + mutation history below.

**Why this assumption**: State is a first-class nav item, and state changes are a core render cause (visible in the Render Causes legend). The data structure (store name, state diff, mutation count) maps directly to a list + detail pattern.

**Alternate**: Could be a timeline view showing state changes over time, with the state tree at each point. However, a list + live state is more useful for debugging.

#### Network > Timeline
**ASSUMPTION**: A horizontal waterfall chart (similar to Chrome DevTools Network waterfall) showing requests as horizontal bars positioned on a time axis, with color indicating status.

**Why this assumption**: The "Timeline" tab is visible in Image 6 next to "Table," and waterfall views are the universal standard for network timeline visualization.

#### Settings > General
**ASSUMPTION**: Form-based settings page with sections for Connection (WebSocket URL, port), Privacy (redaction toggles), Display (theme, density), and About (version, update check).

**Why this assumption**: Settings > General is visible in the sidebar. Limelight has a "beforeSend" callback and "disableBodyCapture" option in the SDK, suggesting user-configurable privacy settings.

### RuntimeScope Additional Screens

| Screen | Components Reused | New Components |
|--------|------------------|----------------|
| API Map | Data table, detail panel, badges | Service map (React Flow), endpoint grouping |
| Database | Data table, detail panel, JSON viewer | Schema map (React Flow), data browser/editor, query timeline |
| Infrastructure | Data table, badges, code viewer | Deploy timeline, log stream, status indicators |
| Sessions | Data table, badges | Diff viewer (side-by-side), regression chart |
| Tracking (GTM/GA4) | Data table, detail panel, badges | Event validation checklist, UTM audit |
| Process Monitor | — | Popover/sidebar widget (see C.6 spec) |
| Overview/Dashboard | Badges, sparklines | Activity feed, stat cards, issue summary |

### Full Sitemap

```
RuntimeScope
├── Overview (dashboard landing)
├── Network
│   ├── Table
│   └── Timeline (waterfall)
├── Renders
│   ├── All (list)
│   ├── Actionable (filtered list)
│   └── Timeline (area chart)
├── State
│   ├── Stores (list + state tree)
│   └── Mutations (timeline)
├── Console (streaming log)
├── API Map
│   ├── Service Map (graph)
│   └── Endpoints (table + detail)
├── Database
│   ├── Schema Map (ER diagram)
│   ├── Query Performance (table)
│   └── Data Browser (table + editor)
├── Performance (Web Vitals dashboard)
├── Infrastructure
│   ├── Deployments (status + logs)
│   └── Services (auto-detected)
├── Issues (aggregated, prioritized)
├── Tracking (GTM/GA4)
├── Sessions
│   ├── History (list)
│   └── Diff (comparison view)
└── Settings
    ├── General
    ├── Projects
    ├── Connections (DB, infrastructure)
    └── Privacy
```

---

## F. Assumptions & Screenshots to Confirm (Ranked)

| Priority | Assumption | What to Confirm | Impact if Wrong |
|----------|-----------|----------------|-----------------|
| 1 | Detail panel overlays content rather than pushing it | Screenshot of full table + open panel showing whether table width changes | Layout architecture changes |
| 2 | Console tab is a single-column log stream | Any screenshot of console tab | Could be a table with columns |
| 3 | Issues tab exists as an aggregated list | Screenshot of Issues tab | Might be a dashboard/card layout |
| 4 | State tab shows stores list + state tree | Screenshot of State tab | Could be a diff-focused timeline |
| 5 | Network Timeline is a waterfall chart | Screenshot of Network > Timeline | Could be a different visualization |
| 6 | Settings is a form-based page | Screenshot of Settings > General | Minimal impact |
| 7 | Table sorting is header-click based | Observation of sort behavior | Could be a separate sort dropdown |
| 8 | Filter "contains" dropdown has modes | Click on "contains" pill | Could be fixed to "contains" only |

---

## G. Build Notes — Implementation Order

### Phase 1: Shell + Tokens (Day 1)

Get the visual foundation right first. Everything else builds on this.

1. **Install dependencies**: `shadcn/ui` init with dark theme, Tailwind v4, Inter font, JetBrains Mono
2. **Set up CSS variables**: All tokens from Section B as CSS custom properties in `:root`
3. **Build AppShell**: The floating content pattern. This is the most important visual element — if this looks right, everything else follows
4. **Build Sidebar**: Nav items with active state. Hardcode the tab list for now
5. **Build Topbar**: Tab row + filter bar + search input

```tsx
// Suggested shadcn/ui components to install immediately:
npx shadcn-ui@latest add badge button input tabs tooltip popover
npx shadcn-ui@latest add dropdown-menu command dialog scroll-area separator
```

### Phase 2: Data Table + Detail Panel (Day 2-3)

These two components appear on 80% of screens. Build them generically.

1. **DataTable**: Using TanStack Table + the styling from C.4. Support for:
   - Custom cell renderers (badges, status dots, method pills)
   - Row selection (single)
   - Header sorting
   - Sticky header
   - Virtualization (TanStack Virtual)
2. **DetailPanel**: The sliding right panel with Details/Insights tabs
3. **Badge system**: All variants from C.8
4. **CodeBlock**: Mono-styled block for JSON, headers, SQL

### Phase 3: First Real Tab (Day 3-4)

Build the Network > Table view as the first real screen. It exercises all core components:
- DataTable with custom cells (status badge, method badge, URL)
- DetailPanel with sub-tabs (Request, Response, Headers, Preview, Timing)
- Filter bar with search
- Summary stats bar

### Phase 4: Charts + Render Views (Day 4-5)

- Area chart (Recharts) with the render timeline styling
- Tooltip component matching Limelight's hover display
- Render cause legend (clickable filter pills)
- Top offenders list with expandable rows
- Causes breakdown bar

### Phase 5: Remaining Tabs

Build each tab, reusing the component library:
- Console (list variant of DataTable)
- Renders (list + timeline + diagnosis panel)
- Issues (table with diagnosis panel)
- State (list + JSON tree viewer)

### Phase 6: RuntimeScope Differentiation

Build the features Limelight doesn't have:
- API Map with React Flow service topology
- Database tab with schema map + data browser
- Process Monitor popover
- Infrastructure connector
- Session diff view

---

## Appendix: RuntimeScope Design Differentiation Strategy

### What to Keep from Limelight
- The floating content container (shell pattern) — it's genuinely good
- Dark-first color system with color used only for data/status
- High information density with clean spacing
- Detail panel pattern (right drawer with tabs)
- Badge system for status/severity/type indicators
- Restrained typography (no huge headers, everything serves the data)

### Where RuntimeScope Should Diverge

| Area | Limelight | RuntimeScope |
|------|-----------|-------------|
| **Color temperature** | Cold blue-black (#0A0A0F) | Slightly warmer dark (#0C0C12 with a hint of warmth) |
| **Accent color** | No strong brand color in data views | Indigo-violet `#6366F1` as brand accent (sidebar active, primary actions) |
| **Charts** | Single purple line, basic area chart | Multi-color system with consistent data type → color mapping across all charts |
| **Empty states** | UNKNOWN (not screenshot'd) | Illustrated empty states with helpful "get started" actions. First-use onboarding |
| **Process monitor** | Doesn't exist | Persistent widget — always-visible quick access. This IS the differentiator UX |
| **Onboarding** | 2-line SDK setup | Interactive project wizard: detect stack → suggest SDK integration → verify connection → first session |
| **Data browser** | N/A | Full inline data editing (Supabase-like) — this should feel polished, not tacked on |
| **Service map** | N/A | Rich interactive graph (React Flow) with health overlays — this is a showcase screen |
| **Session diff** | N/A | Side-by-side visual diffs with clear regression/improvement indicators — build this to be beautiful |
| **Command palette** | No evidence of one | Cmd+K for quick navigation, search, and commands. Feels like Linear/Raycast |
| **Keyboard shortcuts** | UNKNOWN | Full keyboard nav: j/k for row navigation, Enter for detail, Esc to close, 1-9 for tabs |

### Design System Choice: shadcn/ui as Foundation

**Why shadcn/ui works here:**
- Not a component library — it's source code you own and can customize deeply
- Ships with dark mode primitives that match this aesthetic
- Tailwind-based, so all tokens map directly to utility classes
- Components like Command (cmdk), DataTable (TanStack), Tooltip, Popover, Tabs all exist
- Can be reskinned completely without fighting a library's opinions

**What to customize immediately:**
- Override all default colors with the token system above
- Swap default border radius (shadcn uses `--radius: 0.5rem`) to our scale
- Set `--font-sans` and `--font-mono` 
- Build the AppShell separately (shadcn doesn't have a shell component)
- Build the floating content container pattern as a layout primitive

**What NOT to use from shadcn:**
- Their default light-mode-first design language
- Their card component (too generic — build data-specific panels)
- Their toast system (use a custom notification that matches the aesthetic)
- Default table (use TanStack Table with custom styling)

### The "Better but Not Overwhelming" Balance

The risk with adding API Map, Database, Infrastructure, Process Monitor, and Sessions on top of Limelight's feature set is visual overwhelm. Here's the strategy:

1. **Progressive disclosure**: The sidebar shows 5 core tabs by default (Network, Renders, State, Console, Issues). Advanced tabs (API, Database, Infra, Sessions) appear in a "More" section or only after the relevant data is captured
2. **Overview as landing page**: Don't dump users into a tab. Show a clean dashboard with the most important signals. Let them drill into tabs from there
3. **Command palette as escape valve**: When users feel lost, Cmd+K lets them jump anywhere instantly
4. **Consistent three-zone layout**: Every tab uses the same layout: filter/search → main content → detail panel. Users learn the pattern once
5. **Process monitor as persistent widget**: It's not a tab — it's a popover/sidebar widget that's always accessible without navigation. This keeps it useful without adding tab bloat
