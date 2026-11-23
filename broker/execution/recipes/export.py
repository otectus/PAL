from lab_data import params, table, write_table

columns, rows = table()
column = params.get("column", "")
if column and column not in columns:
    raise ValueError(f"Choose a filter column from {columns}")
selected = [r for r in rows if not column or str(r[column]) == str(params.get("value", ""))]
write_table("selected.csv", columns, selected)
print(f"Exported {len(selected)} of {len(rows)} records")
