"""Run one SQL query against ordered input tables using the local Python runtime."""
import csv
import sqlite3
from pathlib import Path
from lab_data import output, params, paths, read_table

sql = Path("/work/main.sql").read_text()
sources = [(f"input{i}", p) for i, p in enumerate(paths, 1)]
for directory in sorted(Path("/work/steps").glob("*")):
    for i, path in enumerate(sorted(directory.iterdir()), 1):
        if path.suffix.lower() in (".csv", ".tsv", ".json", ".jsonl", ".xlsx", ".parquet"):
            sources.append((f"step{directory.name}_{i}", path))
db = sqlite3.connect(":memory:")
def quote(name):
    return '"' + name.replace('"', '""') + '"'
for name, path in sources:
    sheet = params.get("sheet" + name[5:]) if name.startswith("input") else None
    columns, rows = read_table(path, sheet or params.get("sheet"))
    if not columns:
        raise ValueError(f"{path.name} has no columns")
    # Preserve identifiers (including leading zeros). Cast numerical columns explicitly in SQL.
    db.execute(f'CREATE TABLE {name} (' + ','.join(quote(c) for c in columns) + ')')
    db.executemany(f'INSERT INTO {name} VALUES (' + ','.join('?' for _ in columns) + ')',
                   ([r[c] if isinstance(r[c], (int, float, str, type(None))) else str(r[c]) for c in columns] for r in rows))
db.execute("PRAGMA query_only=ON")
cursor = db.execute(sql, params)
if not cursor.description:
    raise ValueError("Enter a query that returns a table")
count = 0
with (output / "result.csv").open("w", newline="") as f:
    writer = csv.writer(f)
    writer.writerow([c[0] for c in cursor.description])
    for row in cursor:
        writer.writerow(row)
        count += 1
print(f"Query returned {count} records from {len(sources)} input tables.")
