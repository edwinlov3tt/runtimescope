# Changelog

All notable changes documented here.

## [0.2.0] - 2026-02-11

### Added
- XHR interception (`interceptXhr`) alongside fetch
- State store observability — Zustand and Redux subscription with state diffing
- React render tracking via React Profiler API with render velocity and cause detection
- Performance metrics via PerformanceObserver (Web Vitals: LCP, FCP, CLS, TTFB, FID, INP)
- DOM snapshot capture via bidirectional server-to-SDK command protocol
- HAR export tool (`export_har`)
- Error aggregation tool (`get_errors`)
- Render summary tool (`get_render_summary`)
- State changes tool (`get_state_changes`)
- Performance metrics tool (`get_performance_metrics`)
- DOM snapshot tool (`capture_dom_snapshot`)
- Issue detectors: excessive re-renders, large state updates, poor Web Vitals
- `beforeSend` hook for event filtering/transformation
- Request/response body capture (opt-in, configurable size limits)
- Configurable batch size and flush interval
- Documentation system (claude-docs-system) with `/audit`, `/sync`, `/onboard` commands

## [0.1.0] - 2026-02-10

### Added
- Initial M1 implementation — full end-to-end runtime profiling pipeline
- Browser SDK with fetch interception and console patching
- WebSocket transport with batching, reconnection, and offline queue
- Collector server with ring buffer (10K events) and query API
- MCP server with stdio transport (6 core tools)
- Issue detection: failed requests, slow requests, N+1, console error spam, high error rate
- Header redaction for privacy
- Event timeline with filtering
- README with quick start guide

---

## Format

- **Added**: New features
- **Changed**: Changes to existing functionality
- **Fixed**: Bug fixes
- **Removed**: Removed features
- **Security**: Security fixes
