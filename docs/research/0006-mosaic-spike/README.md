# Research 0006 — Mosaic ROI spike artifacts

Reproducible artifacts for the Mosaic ROI spike. See the findings section in
[`../0006-mosaic-roi-spike.md`](../0006-mosaic-roi-spike.md). **Verdict: GO**
(ADR-0013). These are data/model files only — Mosaic is **not** a dependency of
this repo; the spike ran against a clone of `github.com/edwinlov3tt/mc-v2`.

| File | What it is |
|---|---|
| `roi.yaml` | **The ROI cube** — dims `[User, Feature, Role, App, Time]`, the ROI formula as 4 YAML rules, baselines/rates as input cells, 14 `golden_tests` encoding the SQL oracle. |
| `oracle.py` | The SQL-formula **reference oracle** + `roi.inputs.csv` generator. Prints value/hours by role/feature/app/time/total. |
| `roi.inputs.csv` | Cube facts (events + broadcast baselines/rates per leaf). |
| `roi-forecast.yaml` + `.inputs.csv` | Forecast layer: a `fitted_models` linear trend → `predict()` projects EOQ2 cumulative value + % to goal. |
| `roi-compare.yaml` + `.inputs.csv` + `narratives/` | Compare-page slice + `mc-narrative` template that renders the leader/decliner insight. |

## Reproduce

```bash
# 1. Build Mosaic (scratch dir — NOT in this repo)
git clone https://github.com/edwinlov3tt/mc-v2 /tmp/mc-v2 && (cd /tmp/mc-v2 && cargo build --release)
MC=/tmp/mc-v2/target/release/mc

# 2. Oracle + facts, then the pass/fail gate (expect 14/14)
python3 oracle.py                 # writes roi.inputs.csv, prints the oracle
$MC model test    roi.yaml         # 14/14 golden = cube matches the SQL oracle
$MC model trace   roi.yaml --coord "Scenario=Actual,Version=Working,User=A,Feature=geocode,Role=Specialist,App=web,Time=2026_01,Measure=value"
$MC model whatif  roi.yaml --set "Scenario=Actual,Version=Working,User=A,Feature=geocode,Role=Specialist,App=web,Time=2026_01,Measure=manual_min=12" --show value
$MC model test    roi-forecast.yaml          # 4/4 — forecast renders
$MC model narrate roi-compare.yaml --templates ./narratives --format markdown

# 3. Daemon (sidecar) probe
mkdir -p /tmp/ws/cubes && cp roi.yaml roi.inputs.csv /tmp/ws/cubes/
# write /tmp/ws/workspace.yaml listing cubes/roi.yaml as name "roi", then:
$MC up --workspace /tmp/ws --port 6790 --api-key k
curl -s -H "Authorization: Bearer k" -H "Content-Type: application/json" -X POST \
  http://127.0.0.1:6790/api/v1/query \
  -d '{"cube":"roi","where":{"Scenario":"Actual","Version":"Working","User":"All_Users","Feature":"All_Features","Role":"All_Roles","App":"All_Apps","Time":"Q1_2026"},"show":["value","hours"]}'
$MC down --workspace /tmp/ws
```
