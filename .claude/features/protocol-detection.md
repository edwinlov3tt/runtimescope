# Feature: Protocol-Aware Response Detection & Rendering

## Status: ⬜ Backlog

## Assessment
- **Phase**: v1.0
- **Complexity**: L (3-5 days)
- **Value**: High
- **Created**: 2026-03-21

## Description
Replace the simple JSON/text/binary response viewer with a protocol-aware detection engine that identifies 17+ response formats (RSC, Turbo Streams, Inertia, Livewire, HTMX, Nuxt payloads, etc.) and renders each with a dedicated, protocol-specific viewer. Users see "This is a Turbo Stream response with 3 DOM actions" instead of a wall of HTML.

## Why
Most dev tools classify responses as HTML, JSON, or text — too shallow for modern frameworks. Next.js RSC streams, Turbo Streams, Inertia page objects, Livewire snapshots, and HTMX fragments are all distinct protocols that look like "broken HTML" or "weird JSON" in generic viewers. Protocol-aware detection makes RuntimeScope genuinely smarter than Chrome DevTools for modern stacks and is a competitive differentiator.

## Scope

### What It Includes
- `detectProtocol()` engine with confidence scoring
- 17 protocol types (see tiers below)
- Per-protocol pretty-printers/renderers in the ResponseViewer
- Protocol badge + plain-English explanation in the UI
- Detection from body content, request/response headers, URL patterns

### What It Doesn't Include
- WebSocket message protocol detection (separate feature)
- Streaming/chunked response reconstruction (body is captured as final string)
- Framework auto-detection from page assets (already handled by scan_website)

## Implementation Tiers

### Tier 1 (ship first — covers 80% of users)
| Protocol | Detection | Frameworks |
|----------|-----------|------------|
| `rsc_flight` | Line format `0:{...}`, `$Sreact.fragment` | Next.js App Router, React RSC |
| `json_api` | Valid JSON, no framework markers | Any REST/GraphQL API |
| `html_document` | `<!doctype`, `<html` | All server-rendered |
| `html_fragment` | HTML without document shell | Partials, AJAX |
| `turbo_stream` | `text/vnd.turbo-stream.html` or `<turbo-stream>` | Rails Hotwire |
| `inertia_page_object` | `X-Inertia` header or `{component, props, url}` JSON | Laravel/Rails + Inertia |
| `html_hydration_state` | HTML + `__NEXT_DATA__`, `__NUXT__`, state blobs | SSR frameworks |
| `binary_or_asset` | File signatures (PK, PDF, PNG, etc.) | File downloads |

### Tier 2 (high value, moderate effort)
| Protocol | Detection |
|----------|-----------|
| `nuxt_payload` | `_payload.json` URL or `__NUXT__` |
| `htmx_fragment` | `HX-Request` header |
| `livewire_snapshot` | `wire:` attributes or snapshot JSON |
| `next_server_action` | POST + RSC-like response in App Router |

### Tier 3 (niche but impressive)
| Protocol | Detection |
|----------|-----------|
| `sveltekit_serialized_data` | SvelteKit data patterns |
| `angular_transfer_state` | Angular SSR markers |
| `astro_islands` | Astro island custom elements |
| `qwik_resumable` | Qwik resumability metadata |
| `phoenix_liveview_diff` | `phx-` attributes, diff payloads |

## Technical Notes

### Systems Affected
- `packages/dashboard/src/components/ui/response-viewer.tsx` — main viewer component
- `packages/dashboard/src/lib/protocol-detector.ts` — new detection engine
- `packages/dashboard/src/lib/protocol-renderers/` — new directory, per-protocol renderers

### Dependencies
- **Requires**: ResponseViewer component (already exists with RSC support)
- **Builds on**: Existing binary detection, JSON pretty-print, RSC parser

### Rough Approach
1. Create `detectProtocol(body, headers?, url?)` function with confidence scoring
2. Create a renderer registry: `Map<ProtocolType, (content: string) => ReactNode>`
3. ResponseViewer calls `detectProtocol()`, picks the right renderer
4. Each renderer shows: protocol badge, plain-English description, structured view
5. "Raw" toggle always available for any protocol
6. Build Tier 1 first, Tier 2/3 as follow-ups

### Reference
Full detection spec with pseudocode, heuristics, and UI recommendations saved at `/Users/edwinlovettiii/formats.txt`

## Questions / Open Items
- Do we have access to response headers in NetworkEvent? (need to verify — detection is much stronger with `content-type` and `X-Inertia` headers)
- Should protocol detection also run in the MCP tool responses (e.g., `get_network_requests` could label each request's protocol)?
- Performance: detection runs on every response body in the detail panel — need to memoize

---

*When ready to implement, run `/task protocol-detection` to generate a detailed task plan.*
