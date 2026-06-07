#!/usr/bin/env python3
"""RuntimeScope ROI SQL-formula oracle + Mosaic canonical_inputs CSV generator.

This is the *reference implementation* of the ROI formula
(analytics-data-model.md §"ROI formula", crates/collector-core/src/analytics_rollups.rs):

    time_saved(event) = (baseline.manual_min - baseline.tool_min) * (per_item ? count : 1)
    value(event)      = (time_saved / 60) * role.hourly_rate   # acting user's role rate
    hours(event)      = time_saved / 60

Rolled up by role / feature / app / time / total. The numbers this prints are the
pass/fail oracle for the Mosaic cube (encoded as golden_tests in roi.yaml).

It also emits roi.inputs.csv — the cube's facts — by broadcasting each event's
baseline + role-rate onto its leaf coordinate (user, feature, role, app, time).
"""
import csv
from collections import defaultdict

# --- analytics.db inputs (slice 1 canonical source) ---------------------------
ROLE_RATE = {"Specialist": 50.0, "Director": 85.0, "Coordinator": 40.0}
USER_ROLE = {"A": "Specialist", "B": "Specialist", "C": "Director"}
# baseline: fn -> (manual_min, tool_min, per_item)
BASELINE = {
    "geocode": (8.0, 2.4, True),
    "export":  (15.0, 5.0, False),
}

# --- the event fixture (anonId, feature, app, time, count) --------------------
# Mirrors the analytics_rollups.rs test spine (A/B/C, geocode/export), extended
# with the count + app + baseline data slice-3 ROI needs.
EVENTS = [
    ("A", "geocode", "web", "2026_01", 10),
    ("A", "geocode", "web", "2026_02", 5),
    ("A", "export",  "web", "2026_02", 1),   # per_item=false -> count ignored
    ("B", "geocode", "cli", "2026_02", 20),
    ("C", "export",  "web", "2026_03", 1),   # per_item=false
]

# --- per-event ROI (the formula) ---------------------------------------------
def per_event(ev):
    anon, feat, app, t, count = ev
    manual, tool, per_item = BASELINE[feat]
    rate = ROLE_RATE[USER_ROLE[anon]]
    qty = count if per_item else 1
    ts = (manual - tool) * qty            # minutes
    hours = ts / 60.0
    value = hours * rate
    return ts, hours, value

# --- aggregate into leaves (user,feature,role,app,time) -----------------------
leaves = defaultdict(lambda: {"events": 0, "items": 0})
for ev in EVENTS:
    anon, feat, app, t, count = ev
    role = USER_ROLE[anon]
    key = (anon, feat, role, app, t)
    leaves[key]["events"] += 1
    leaves[key]["items"] += count

# --- write canonical_inputs CSV (one row per input measure per leaf) ----------
INPUT_MEASURES = ["events", "items", "manual_min", "tool_min", "per_item", "hourly_rate"]
rows = []
for (anon, feat, role, app, t), agg in sorted(leaves.items()):
    manual, tool, per_item = BASELINE[feat]
    rate = ROLE_RATE[role]
    vals = {
        "events": float(agg["events"]),
        "items": float(agg["items"]),
        "manual_min": manual,
        "tool_min": tool,
        "per_item": 1.0 if per_item else 0.0,
        "hourly_rate": rate,
    }
    for m in INPUT_MEASURES:
        rows.append(["Actual", "Working", anon, feat, role, app, t, m, vals[m]])

with open("roi.inputs.csv", "w", newline="") as f:
    w = csv.writer(f)
    w.writerow(["Scenario", "Version", "User", "Feature", "Role", "App", "Time", "Measure", "value"])
    w.writerows(rows)

# --- compute the oracle rollups ----------------------------------------------
def rollup(keyfn):
    out = defaultdict(lambda: [0.0, 0.0])  # [hours, value]
    for ev in EVENTS:
        ts, hours, value = per_event(ev)
        k = keyfn(ev)
        out[k][0] += hours
        out[k][1] += value
    return out

by_role = rollup(lambda e: USER_ROLE[e[0]])
by_feat = rollup(lambda e: e[1])
by_app = rollup(lambda e: e[2])
by_time = rollup(lambda e: e[3])
total_h = sum(per_event(e)[1] for e in EVENTS)
total_v = sum(per_event(e)[2] for e in EVENTS)

def show(title, d):
    print(f"\n== {title} ==")
    for k in sorted(d):
        print(f"  {k:14} hours={d[k][0]:.6f}  value={d[k][1]:.6f}")

show("by role", by_role)
show("by feature", by_feat)
show("by app", by_app)
show("by time (month)", by_time)
print(f"\n== TOTAL ==  hours={total_h:.6f}  value={total_v:.6f}")
print(f"\nWrote roi.inputs.csv ({len(rows)} rows, {len(leaves)} leaves)")
