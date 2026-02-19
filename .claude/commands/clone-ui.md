---
description: Clone a UI component — scan, snapshot, extract styles, design tokens, fonts
allowed-tools: ["Bash", "Read", "Write", "Edit", "Grep", "Glob"]
---

# Clone UI — Component Recreation

Scan a website and extract everything needed to recreate a specific component: element structure, computed styles, design tokens, and fonts.

**Usage**: `/clone-ui $ARGUMENTS`

**Examples**:
- `/clone-ui https://stripe.com .hero-section` — clone Stripe's hero
- `/clone-ui https://linear.app nav` — clone Linear's navigation
- `/clone-ui https://vercel.com [data-testid="pricing-card"]` — clone a pricing card
- `/clone-ui https://myapp.com .card` — clone a card component

`$ARGUMENTS` should be: `[URL] [CSS selector]`. If incomplete, ask for the missing part.

---

## Phase 1: Parse Arguments

Extract URL and selector from `$ARGUMENTS`:
- First argument: URL (starts with `http`)
- Remaining: CSS selector

If URL is missing, ask: "What URL should I scan?"
If selector is missing, ask: "What element should I clone? (CSS selector like `.card`, `nav`, `#hero`)"

---

## Phase 2: Scan the Page

Run `scan_website` with the URL if not already scanned (check if recon data exists for this URL).

---

## Phase 3: Extract Component Data

Run these tools targeting the specific selector:

1. **`get_element_snapshot`** — Deep DOM structure with attributes, bounding rects, and computed styles for every node
   - `selector`: the CSS selector
   - `depth`: 5 (or more for complex components)

2. **`get_computed_styles`** — Full computed styles for the root element
   - `selector`: the CSS selector
   - `properties`: `all`

3. **`get_design_tokens`** — Page-level design tokens (colors, typography, spacing, CSS vars)

4. **`get_font_info`** — Font faces and loading info

---

## Phase 4: Build the Recreation Spec

```markdown
# Clone Spec: [selector] from [URL]

## Component Structure
```html
<!-- Generated from element snapshot -->
<div class="card">
  <img class="card-image" src="..." alt="...">
  <div class="card-body">
    <h3 class="card-title">Title</h3>
    <p class="card-text">Description text</p>
    <button class="card-cta">Learn more</button>
  </div>
</div>
```

## Computed Styles (Root Element)
| Property | Value |
|----------|-------|
| display | flex |
| flex-direction | column |
| background-color | #ffffff |
| border-radius | 12px |
| box-shadow | 0 4px 6px rgba(0,0,0,0.1) |
| padding | 24px |
| width | 360px |

## Child Element Styles
### .card-image
| Property | Value |
|----------|-------|
| width | 100% |
| height | 200px |
| object-fit | cover |
| border-radius | 8px 8px 0 0 |

### .card-title
| Property | Value |
|----------|-------|
| font-family | Inter |
| font-size | 20px |
| font-weight | 600 |
| color | #1a1a2e |

[...continue for each child]

## Design Tokens Used
| Token | Value | Usage |
|-------|-------|-------|
| --primary-color | #6366f1 | button background |
| --border-radius | 12px | card corners |
| --spacing-md | 16px | card padding |

## Fonts Required
| Font | Weight | Style | Source |
|------|--------|-------|--------|
| Inter | 400 | normal | Google Fonts |
| Inter | 600 | normal | Google Fonts |

## Assets
[List any images, SVGs, or icons used by the component]
```

---

## Phase 5: Generate Code

Based on the extraction, generate the actual component code:

1. Detect the user's tech stack from `package.json` or ask
2. Generate the component in the appropriate framework (React, Vue, Svelte, HTML)
3. Include all styles (Tailwind classes, CSS modules, or inline styles based on project conventions)
4. Write the file to the appropriate location in the project

Ask the user where to save the component before writing.
