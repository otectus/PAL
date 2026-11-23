from lab_data import paths, table, write_table

if not paths:
    raise ValueError("Choose at least one table")
summary = []
for i, path in enumerate(paths):
    columns, rows = table(i)
    for column in columns:
        values = [str(row[column]).strip() if row[column] is not None else "" for row in rows]
        summary.append({"file": path.name, "column": column, "rows": len(rows),
                        "missing": values.count(""), "distinct_nonempty": len(set(values) - {""})})
    print(f"{path.name}: {len(rows)} records, {len(columns)} columns")
write_table("summary.csv", ["file", "column", "rows", "missing", "distinct_nonempty"], summary)
