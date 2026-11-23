import math
import matplotlib.pyplot as plt
from lab_data import output, params, paths, table, write_table

columns, rows = table()
if len(columns) < 2:
    raise ValueError("Choose a table with at least two columns")
x_name, y_name = params.get("x") or columns[0], params.get("y") or columns[1]
if x_name not in columns or y_name not in columns:
    raise ValueError(f"Choose X and Y from {columns}")
points, skipped = [], []
for index, row in enumerate(rows, 1):
    try:
        x = row[x_name]
        y = float(row[y_name])
        if not str(x).strip() or not math.isfinite(y):
            raise ValueError()
        points.append((index, x, y))
    except (ValueError, TypeError):
        skipped.append(index)
if not points:
    raise ValueError("No records have both an X value and a finite numeric Y value")
xs = [x for _, x, _ in points]
try:
    xs = [float(x) for x in xs]
except (TypeError, ValueError):
    xs = [str(x) for x in xs]
plt.figure(figsize=(8, 4.5))
plt.plot(xs, [y for _, _, y in points], marker="o")
plt.xlabel(params.get("xLabel") or x_name)
plt.ylabel(params.get("yLabel") or y_name)
plt.title(f"{y_name} by {x_name}")
plt.grid(alpha=.3)
plt.tight_layout()
plt.savefig(output / "plot.png", dpi=150)
write_table("plot-data.csv", ["source_record", "x", "y"],
            ({"source_record": i, "x": x, "y": y} for i, x, y in points))
if skipped:
    write_table("excluded.csv", ["source_record", "reason"],
                ({"source_record": i, "reason": "Missing X or invalid numeric Y"} for i in skipped))
print(f"Plotted {len(points)} rows from {paths[0].name}. Excluded {len(skipped)} records with missing X or invalid numeric Y.")
