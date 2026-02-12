# Feature Backlog

Ideas and planned features organized by phase. Based on PRD milestones (M1-M13).

## Status Legend
- ⬜ Backlog (idea logged)
- 🔄 In Progress (task created)
- ✅ Shipped (archived)

---

## MVP — Must Ship

| Feature | Complexity | Value | Status | PRD Ref |
|---------|------------|-------|--------|---------|
| Core Pipeline (SDK + Collector + MCP) | L | Critical | ✅ Shipped | M1 |
| Dashboard MVP (Network + Console tabs) | L | High | ⬜ Backlog | M2 |
| Test infrastructure | M | High | ⬜ Backlog | — |

## v1.0 — First Release

| Feature | Complexity | Value | Status | PRD Ref |
|---------|------------|-------|--------|---------|
| API Discovery & Health Map | M | High | ⬜ Backlog | M3 |
| React Render Dashboard Tab | M | High | ⬜ Backlog | M4 (SDK done) |
| State Store Dashboard Tab | M | Medium | ⬜ Backlog | M5 (SDK done) |
| Performance/Web Vitals Dashboard | M | Medium | ⬜ Backlog | M11 (SDK done) |
| SQLite persistence + Session diffing | L | High | ⬜ Backlog | M9 |

## v1.1 — Fast Follow

| Feature | Complexity | Value | Status | PRD Ref |
|---------|------------|-------|--------|---------|
| Database Visualization & Query Monitor | XL | High | ⬜ Backlog | M6 |
| Dev Process Monitor | M | Medium | ⬜ Backlog | M7 |
| Infrastructure Connector (MCP Hub) | L | Medium | ⬜ Backlog | M8 |

## v2.0 — Future

| Feature | Complexity | Value | Status | PRD Ref |
|---------|------------|-------|--------|---------|
| Tauri Desktop App | XL | Medium | ⬜ Backlog | M10 |
| Cloud Sync + Production Telemetry | L | Medium | ⬜ Backlog | M12 |
| GTM/GA4 Marketing Extensions | M | Low | ⬜ Backlog | M13 |

---

## Working with Features

### Log an idea
```
/feature add real-time collaboration
```

### View backlog
```
/feature
/feature mvp
```

### Build a feature
```
/task [feature-name]
```

## Complexity Guide
- **S** — < 1 day, single file changes
- **M** — 1-3 days, multiple files
- **L** — 3-7 days, cross-cutting concerns
- **XL** — 1-2+ weeks, major subsystem

## Phase Guide
- **MVP** — Can't ship without it
- **v1.0** — Important for first release
- **v1.1** — Ship shortly after launch
- **v2.0** — Future vision
