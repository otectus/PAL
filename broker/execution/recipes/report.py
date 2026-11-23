import matplotlib.pyplot as plt
from lab_data import output, params, paths, table, write_table

columns, body = table()
if len(columns) < 2 or not body:
    raise ValueError("Choose a nonempty table with two columns")
x, y = params.get("x") or columns[0], params.get("y") or columns[1]
values = [float(r[y]) for r in body]
plt.figure(figsize=(7, 4))
plt.bar([str(r[x]) for r in body], values)
plt.tight_layout()
plt.savefig(output / "chart.png", dpi=150)
write_table("source.csv", columns, body)
(output / "report.md").write_text(f"# {y} by {x}\n\nSource: {paths[0].name} ({len(body)} records).\n\n![Chart](chart.png)\n\n[Source records](source.csv)\n")
print(f"Report covers {len(body)} records.")
