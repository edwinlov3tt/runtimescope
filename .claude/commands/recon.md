---
description: Full website recon — tech stack, design tokens, layout, fonts, accessibility, assets
allowed-tools: ["Bash", "Read", "Grep", "Glob"]
---

# Recon — Full Website Analysis

Scan a website and extract everything: tech stack (7,221 technologies), design system, layout structure, typography, accessibility, and asset inventory. Returns a comprehensive design specification.

**Usage**: `/recon $ARGUMENTS`

**Examples**:
- `/recon https://stripe.com` — full recon on Stripe
- `/recon https://linear.app` — full recon on Linear
- `/recon https://localhost:3000` — recon your own app

`$ARGUMENTS` should be a full URL. If not provided, ask for one.

---

## Phase 1: Scan

If `$ARGUMENTS` is empty, ask: "What URL would you like to scan?"

Run `scan_website` with the provided URL:
- `url`: `$ARGUMENTS`
- `wait_for`: `networkidle`

If the scan fails with a Playwright error, suggest: `npx playwright install chromium`

---

## Phase 2: Extract All Data

After the scan completes, run all recon tools in sequence:

1. **`get_page_metadata`** — Tech stack, framework, hosting, meta tags
2. **`get_design_tokens`** — CSS variables, colors, typography scale, spacing, shadows
3. **`get_layout_tree`** — DOM structure with flex/grid layout info
4. **`get_font_info`** — Font faces, usage, icon fonts, loading strategy
5. **`get_accessibility_tree`** — Headings, landmarks, forms, images, issues
6. **`get_asset_inventory`** — Images, SVGs, sprites, icon fonts

---

## Phase 3: Comprehensive Report

```markdown
# Website Recon: [title]

**URL**: [url]
**Scan time**: Xms

---

## Tech Stack
| Category | Technology | Version | Confidence |
|----------|-----------|---------|------------|
| Framework | React | 18.2 | High |
| Meta-framework | Next.js | 14.1 | High |
| UI Library | Tailwind CSS | 3.4 | High |
| Hosting | Vercel | — | High |
| Analytics | Google Analytics | — | Medium |

## Design System

### Colors
| Color | Hex | Usage | Properties |
|-------|-----|-------|------------|
| [swatch] | #1a1a2e | 45 uses | color, background-color |

### Typography
| Font | Size | Weight | Line Height | Usage |
|------|------|--------|-------------|-------|
| Inter | 16px | 400 | 1.5 | 120 elements |

### Spacing Scale
| Value | Usage Count |
|-------|-------------|
| 8px | 89 |
| 16px | 67 |
| 24px | 45 |

### CSS Architecture
- **Approach**: [Tailwind / BEM / CSS Modules / Vanilla]
- **Custom properties**: X CSS variables
- **Sample classes**: [top 10 class names]

## Layout
- **Total elements**: X
- **Max depth**: X
- **Key layout patterns**: flex (X), grid (X)

## Typography
- **Font faces**: X loaded
- **Loading strategy**: [preload + font-display: swap + woff2]
- **Icon fonts**: [none / FontAwesome / Material Icons]

## Accessibility
| Check | Result |
|-------|--------|
| Heading hierarchy | [OK / Issues found] |
| Landmarks (nav, main) | [OK / Missing <main>] |
| Images with alt text | X/Y have alt |
| Form labels | [OK / Issues] |

**Issues**: [list any a11y warnings]

## Assets
| Type | Count |
|------|-------|
| Images | X |
| Inline SVGs | X |
| SVG Sprites | X |
| Background Sprites | X |

---

## Next Steps
- Run `/clone-ui [url] [selector]` to recreate a specific component
- Use `get_computed_styles` for exact CSS values on any selector
- Use `get_element_snapshot` for deep component inspection
```
