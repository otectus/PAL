"""Read the exact ordered inputs and parameters of this analysis inside Code Lab."""
import csv
import json
import posixpath
import re
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

work = Path("/work")
paths = [Path(p) for p in json.loads((work / "inputs.json").read_text())]
params = json.loads((work / "parameters.json").read_text())
output = work / "output"


def spreadsheet(path, sheet):
    """Read cached cell values from a selected visible XLSX worksheet."""
    with zipfile.ZipFile(path) as book:
        def xml(member):
            if book.getinfo(member).file_size > 64 * 1024 * 1024:
                raise ValueError(f"Worksheet part {member} exceeds 64 MiB")
            return ET.fromstring(book.read(member))
        workbook = xml("xl/workbook.xml")
        sheets = [s for s in workbook.findall(".//{*}sheet") if s.get("state", "visible") == "visible"]
        target = next((s for s in sheets if s.get("name") == sheet), None) if sheet else next(iter(sheets), None)
        if target is None:
            raise ValueError(f"Choose a visible sheet from {[s.get('name') for s in sheets]}")
        rid = next(v for k, v in target.attrib.items() if k.endswith("}id"))
        rel = next(r for r in xml("xl/_rels/workbook.xml.rels") if r.get("Id") == rid)
        part = rel.get("Target", "")
        if rel.get("TargetMode") == "External":
            raise ValueError("External worksheet links cannot be read")
        part = part.lstrip("/") if part.startswith("/") else posixpath.normpath("xl/" + part)
        strings = []
        if "xl/sharedStrings.xml" in book.namelist():
            strings = ["".join(t.text or "" for t in s.findall(".//{*}t")) for s in xml("xl/sharedStrings.xml")]
        result = []
        for row in xml(part).findall(".//{*}sheetData/{*}row"):
            values = []
            for cell in row.findall("{*}c"):
                letters = re.match(r"^[A-Z]+", cell.get("r", ""))
                index = 0
                if letters:
                    for c in letters.group():
                        index = index * 26 + ord(c) - 64
                else:
                    index = len(values) + 1
                if not 1 <= index <= 16384:
                    raise ValueError("Invalid worksheet column")
                value = cell.findtext("{*}v") or ""
                if cell.get("t") == "s":
                    value = strings[int(value)]
                elif cell.get("t") == "inlineStr":
                    value = "".join(t.text or "" for t in cell.findall(".//{*}t"))
                values += [""] * (index - len(values))
                values[index - 1] = value
            if any(values):
                result.append(values)
        return result


def read_table(path, sheet=None):
    suffix = path.suffix.lower()
    if suffix == ".xlsx":
        rows = spreadsheet(path, sheet)
    elif suffix in (".json", ".jsonl", ".ndjson", ".parquet"):
        if suffix == ".parquet":
            try:
                import duckdb
            except ImportError as exc:
                raise ValueError("Parquet needs the optional DuckDB package in the desktop Python runtime") from exc
            relation = duckdb.read_parquet(str(path))
            return relation.columns, [dict(zip(relation.columns, r)) for r in relation.fetchall()]
        with path.open(encoding="utf-8-sig") as f:
            records = json.load(f) if suffix == ".json" else [json.loads(line) for line in f if line.strip()]
        if not isinstance(records, list) or any(not isinstance(r, dict) for r in records):
            raise ValueError(f"{path.name} must contain records with named fields")
        names = list(dict.fromkeys(k for r in records for k in r))
        return names, [{k: r.get(k, "") for k in names} for r in records]
    elif suffix in (".csv", ".tsv"):
        with path.open(newline="", encoding="utf-8-sig") as f:
            rows = list(csv.reader(f, delimiter="\t" if suffix == ".tsv" else ",", strict=True))
    else:
        raise ValueError(f"Choose a CSV, TSV, XLSX, JSON, JSONL or Parquet table, received {path.name}")
    if not rows or not rows[0]:
        raise ValueError(f"{path.name} has no header")
    headers = rows[0]
    if any(not h.strip() for h in headers) or len(set(headers)) != len(headers):
        raise ValueError(f"{path.name} needs distinct, non-empty column names")
    result = []
    for i, row in enumerate(rows[1:], 1):
        if not row:
            continue
        if len(row) > len(headers) or (suffix != ".xlsx" and len(row) != len(headers)):
            raise ValueError(f"{path.name}: record {i} has {len(row)} fields, expected {len(headers)}")
        result.append(dict(zip(headers, row + [""] * (len(headers) - len(row)))))
    return headers, result


def table(index=0):
    if len(paths) <= index:
        raise ValueError(f"Select input file {index + 1} first")
    return read_table(paths[index], params.get(f"sheet{index + 1}") or params.get("sheet"))


def write_table(name, headers, rows):
    with (output / name).open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=headers)
        writer.writeheader()
        writer.writerows(rows)
