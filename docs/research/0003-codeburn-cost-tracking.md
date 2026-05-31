# CodeBurn comparison — what to borrow for RuntimeScope's pm/ cost tracking

**Status:** `active`
**Created:** 2026-05-31
**Spans phases:** post-M5 / v1.1 pm-hardening
**Source reviewed:** `getagentseal/codeburn` (MIT, © 2026 AgentSeal) — a local CLI/TUI that "sees where your AI coding tokens go" across 25 tools, pricing via LiteLLM.

## Why this matters

RuntimeScope's pm/ subsystem already parses Claude Code sessions for cost/token/
active-time/compaction (`pm_session_parser.rs`) + CapEx accounting. CodeBurn solves
the same "where did the tokens/$ go" problem and does two things materially better
than us. Reviewed to decide what to fold in.

## What CodeBurn does that we should consider

1. **LiteLLM pricing snapshot + self-refresh — HIGH value, fixes a latent bug.**
   - CodeBurn bundles `src/data/litellm-snapshot.json` (**3,636 models**, tuples
     `[input, output, cacheWrite?, cacheRead?]`, with `cacheWrite ?? input*1.25`,
     `cacheRead ?? input*0.1` fallbacks) AND refreshes from the upstream LiteLLM
     URL (`model_prices_and_context_window.json`) with a 24h cache. Plus a
     `fastMultiplier` for fast-mode models (opus-4-6/4-7 = 6×).
   - **Our `MODEL_PRICING` is 5 hardcoded Claude models with fuzzy-match hacks**
     (`pm_session_parser.rs` / `session-parser.ts`). It silently returns wrong/0
     cost the moment a new model ships, and the "empty model → sonnet" quirk shows
     how fragile the fuzzy match is. A bundled+refreshing pricing table is the fix —
     comprehensive, self-updating, MIT-licensed (attribution).
   - **Caveat (why this is post-M5, not now):** our Rust cost is currently
     Node-parity, gated by `pm_session_parser` unit tests with Node-captured cost
     values. Swapping to LiteLLM pricing DIVERGES from Node's numbers, so it must be
     a **coordinated Node + Rust change** (update `session-parser.ts` too) or a
     documented Rust improvement that re-baselines the cost tests. Don't swap
     mid-port.

2. **Task-type classifier — MEDIUM value, fills a real gap.**
   - `src/classifier.ts` classifies each turn into test/git/build/install/debug/
     feature/refactor/brainstorm/research by the **tools used** (Edit/Read/Bash/
     Task/Search/MCP/Skill sets) + **prompt keywords** (regex). Feeds spend-by-task
     breakdowns.
   - **Our pm/ CapEx has a work-type classification STUB** (deferred). CodeBurn's
     classifier is a concrete, borrowable implementation to (a) make CapEx work-type
     real (capitalizable vs expensed) and (b) add a spend-by-task-type view.

## What NOT to borrow

3. **25 multi-tool provider adapters** (Cursor/Codex/Gemini/Copilot/OpenCode/Cline/…
   via `src/providers/*` + a SQLite session parser). RuntimeScope is Claude-Code-
   centric *runtime* monitoring; supporting 25 coding tools is a different product /
   scope creep. **Skip** — but note the `sqlite-session-parser.ts` pattern if we ever
   add Cursor/OpenCode session import.
4. **Cost-analytics features** (`optimize.ts`, `plan-usage.ts`/`plans.ts`,
   `model-efficiency.ts`, `context-budget.ts`). Complementary to monitoring but a
   product decision, not a port task. Future.

## Where we're already even / ahead

- We parse Claude sessions for the same metrics (cost/token/active-time/compaction).
- **CapEx capitalization accounting is ours** — CodeBurn's "task type" is for spend
  breakdown, not accounting. That's a RuntimeScope differentiator to keep.

## Decision

- **Adopt #1 (LiteLLM pricing)** as a post-M5 coordinated Node+Rust change — it's a
  real correctness fix for both. ([feature](../../.claude/features/litellm-pricing-snapshot.md))
- **Consider #2 (task-type classifier)** to complete the CapEx work-type + a
  by-task spend view. ([feature](../../.claude/features/session-task-type-classifier.md))
- **Defer #3/#4.** Not now.
- Borrowing CodeBurn code/data is license-clean (MIT) **with attribution** — review
  before copying.
