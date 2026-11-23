"""Rank the groups responsible for a change in a numeric measure."""
import math
from collections import defaultdict
import matplotlib.pyplot as plt
from lab_data import output, params, paths, table, write_table

if len(paths) != 2:
    raise ValueError("Select the before table followed by the after table")
group, metric = params.get("key"), params.get("metric")
totals = [defaultdict(float), defaultdict(float)]
records, excluded = [], []
for i, period in enumerate(["before", "after"]):
    columns, rows = table(i)
    if group not in columns or metric not in columns:
        raise ValueError(f"Choose a grouping and numeric measure present in {paths[i].name}: {columns}")
    for number, row in enumerate(rows, 1):
        try:
            key = str(row[group]).strip() if row[group] is not None else ""
            value = float(row[metric])
            if not key or not math.isfinite(value):
                raise ValueError()
        except (TypeError, ValueError):
            excluded.append({"period": period, "input_record": number, "reason": "Missing group or nonnumeric measure"})
            continue
        totals[i][key] += value
        records.append({"group": key, "period": period, "input_record": number, "value": value})
if not records:
    raise ValueError("No usable records in the selected tables")
before, after = totals
net = sum(after.values()) - sum(before.values())
rows = []
for key in sorted(before.keys() | after.keys()):
    delta = after[key] - before[key]
    rows.append({"group": key, "before": before[key], "after": after[key], "change": delta,
                 "share_of_net_change_pct": 100 * delta / net if net else ""})
rows.sort(key=lambda r: -abs(r["change"]))
write_table("contributions.csv", list(rows[0]), rows)
write_table("contributing-records.csv", ["group", "period", "input_record", "value"], records)
if excluded:
    write_table("excluded.csv", ["period", "input_record", "reason"], excluded)
shown = rows[:15][::-1]
plt.figure(figsize=(8, max(3, .35 * len(shown) + 1.5)))
plt.barh([r["group"] for r in shown], [r["change"] for r in shown])
plt.xlabel(params.get("unit") or f"Change in {metric}")
plt.axvline(0, color=".35", linewidth=.7)
plt.tight_layout()
plt.savefig(output / "contributions.png", dpi=150)
print(f"Net change in {metric}: {net:g}. Grouped by {group}. Used {len(records)} records, excluded {len(excluded)}. Ranked by absolute contribution.")
