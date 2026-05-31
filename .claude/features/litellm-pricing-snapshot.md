# Feature: LiteLLM Pricing Snapshot (replace the hardcoded 5-model table)

## Status: ⬜ Backlog

## Assessment
- **Phase**: post-M5 / v1.1 — coordinated Node + Rust change
- **Complexity**: M (bundle snapshot + lookup + optional 24h refresh; re-baseline cost tests)
- **Value**: High (correctness — current pricing silently goes stale/wrong)
- **Created**: 2026-05-31
- **Source**: CodeBurn (MIT) — `src/data/litellm-snapshot.json` + `src/models.ts`

## Description
Replace the hardcoded `MODEL_PRICING` (5 Claude models + fuzzy-match hacks, in both
`pm_session_parser.rs` and Node `session-parser.ts`) with a bundled LiteLLM pricing
snapshot (~3.6K models; tuples `[input, output, cacheWrite?, cacheRead?]` with
`cacheWrite ?? input*1.25` / `cacheRead ?? input*0.1` fallbacks), optionally
refreshed from `litellm/model_prices_and_context_window.json` with a 24h cache.

## Why
The current table returns wrong/zero cost the moment a new model ships (it already
hardcodes opus-4-6/sonnet-4-6; 4-7 would mis-price), and the fuzzy fallback is
fragile (empty model → sonnet). A maintained, comprehensive table fixes both.

## Caveat / sequencing
Rust cost is currently Node-parity, gated by `pm_session_parser` unit tests with
Node-captured values. This MUST be a coordinated Node+Rust change (or a documented
Rust improvement that re-baselines the cost tests) — not a mid-port swap. Do after M5.
MIT-licensed source; attribution required.

## Notes
See `docs/research/0003-codeburn-cost-tracking.md`.
