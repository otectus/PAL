import json
from collections import Counter
from lab_data import params, paths, table, write_table

if len(paths) != 2:
    raise ValueError("Choose the before file first and the after file second")
old_columns, before = table(0)
new_columns, after = table(1)
raw_key = params.get("key", "")
keys = raw_key if isinstance(raw_key, list) else [k.strip() for k in raw_key.split(",") if k.strip()]
positional = params.get("mode") == "position"
if not positional and (not keys or any(k not in old_columns or k not in new_columns for k in keys)):
    raise ValueError("Choose matching key columns in both files, or set mode to position")


def index_rows(rows, path):
    result = {}
    for number, row in enumerate(rows, 1):
        key = (number,) if positional else tuple(row[k] for k in keys)
        if any(value == "" or value is None for value in key):
            raise ValueError(f"{path.name}: missing key at record {number}")
        if key in result:
            raise ValueError(f"{path.name}: duplicate key {key} at records {result[key][0]} and {number}")
        result[key] = (number, row)
    return result


old = index_rows(before, paths[0])
new = index_rows(after, paths[1])
changes = []
counts = Counter()
for key in dict.fromkeys([*old, *new]):
    old_index, a = old.get(key, ("", None))
    new_index, b = new.get(key, ("", None))
    kind = "added" if a is None else "removed" if b is None else "modified" if a != b else "unchanged"
    counts[kind] += 1
    if kind != "unchanged":
        changes.append({"change": kind, "key": json.dumps(key, ensure_ascii=False), "before_record": old_index,
                        "after_record": new_index, "before": json.dumps(a, ensure_ascii=False) if a is not None else "",
                        "after": json.dumps(b, ensure_ascii=False) if b is not None else ""})
write_table("changes.csv", ["change", "key", "before_record", "after_record", "before", "after"], changes)
print(f"Compared {len(before)} before and {len(after)} after records. " +
      ", ".join(f"{kind}: {counts[kind]}" for kind in ("added", "removed", "modified", "unchanged")) + ".")
