"""
Generates per-version JSON graphs of relationships between FFXIV datamining CSV files,
then produces diffs between each consecutive version pair.

Versions are registered in versions.json at the project root.

Run from the project root:
    python generate_csv_graph.py

Outputs (one per version, project root — build intermediates, not deployed):
    csv_graph_{version_id}.json

Outputs (one per consecutive pair, written to site/ — deployed to gh-pages):
    site/diff_{from_id}_to_{to_id}.json      — schema + edge diffs
    site/data_diff_{from_id}_to_{to_id}.json — row-level data diffs for tables with stable schemas
"""
import csv
import json
from datetime import datetime, timezone
from pathlib import Path

VERSIONS_FILE = Path("versions.json")
SITE_DIR      = Path("site")
# Ordered by preference: language-scoped layout (7.41+) then flat layout (pre-7.41)
CSV_SUBDIRS   = [Path("csv/en"), Path("csv")]


def find_csv_dir(version_path: Path) -> Path | None:
    """Return the CSV root for a version, probing for language subfolder then flat csv/."""
    for sub in CSV_SUBDIRS:
        candidate = version_path / sub
        if candidate.is_dir():
            return candidate
    return None


def _row_sort_key(row_id: str) -> tuple:
    try:
        return (0, int(row_id), "")
    except ValueError:
        return (1, 0, row_id)


def _to_int_id(s: str) -> int | str:
    try:
        return int(s)
    except ValueError:
        return s


def read_schema_columns(csv_path: Path) -> list[str] | None:
    """Return column list if the file is a schema table, else None.

    Supports two header layouts:
      Modern (7.41+): first line is '#,ColA,ColB,...'
      Legacy (7.3x):  first line is 'key,0,1,...', second line is '#,ColA,ColB,...'
    """
    try:
        with open(csv_path, encoding="utf-8-sig", errors="replace") as f:
            first_line = f.readline().rstrip("\n")
            if first_line.startswith("#"):
                return next(csv.reader([first_line]))
            if first_line.startswith("key,"):
                second_line = f.readline().rstrip("\n")
                if second_line.startswith("#"):
                    return next(csv.reader([second_line]))
    except OSError:
        pass
    return None


def build_graph(base_dir: Path) -> dict:
    all_paths = sorted(base_dir.rglob("*.csv"))
    print(f"  Found {len(all_paths)} CSV files, reading headers...")

    tables: dict[str, dict] = {}
    duplicate_stems: set[str] = set()

    for csv_path in all_paths:
        stem     = csv_path.stem
        rel_path = csv_path.relative_to(base_dir).as_posix()
        rel_dir  = csv_path.parent.relative_to(base_dir).as_posix()
        columns  = read_schema_columns(csv_path)

        if stem in tables:
            duplicate_stems.add(stem)
        else:
            tables[stem] = {"path": rel_path, "dir": rel_dir, "columns": columns}

    if duplicate_stems:
        print(f"  Warning: {len(duplicate_stems)} duplicate stem(s) — only first occurrence kept:")
        for s in sorted(duplicate_stems):
            print(f"    {s}")

    all_stems = set(tables)
    nodes: list[dict] = []
    edges: list[dict] = []

    for stem, info in tables.items():
        node: dict = {
            "id":        stem,
            "path":      info["path"],
            "dir":       info["dir"],
            "is_schema": info["columns"] is not None,
        }
        if info["columns"] is not None:
            node["columns"] = info["columns"]
        nodes.append(node)

        if info["columns"]:
            for col in info["columns"]:
                if col in all_stems and col != stem:
                    edges.append({"source": stem, "target": col, "via": col})

    schema_count = sum(1 for n in nodes if n["is_schema"])
    return {
        "metadata": {
            "generated":               datetime.now(timezone.utc).isoformat(),
            "root":                    base_dir.as_posix(),
            "total_nodes":             len(nodes),
            "schema_nodes":            schema_count,
            "text_nodes":              len(nodes) - schema_count,
            "total_edges":             len(edges),
            "duplicate_stems_skipped": sorted(duplicate_stems),
        },
        "nodes": nodes,
        "edges": edges,
    }


def build_diff(graph_a: dict, graph_b: dict, from_id: str, to_id: str) -> dict:
    """Compare two version graphs and return a structured schema + relationship diff."""
    schema_a = {n["id"]: n for n in graph_a["nodes"] if n["is_schema"]}
    schema_b = {n["id"]: n for n in graph_b["nodes"] if n["is_schema"]}

    ids_a, ids_b   = set(schema_a), set(schema_b)
    added_tables   = sorted(ids_b - ids_a)
    removed_tables = sorted(ids_a - ids_b)

    changed_tables: dict[str, dict] = {}
    for tid in sorted(ids_a & ids_b):
        cols_a = set(schema_a[tid].get("columns", []))
        cols_b = set(schema_b[tid].get("columns", []))
        added_cols   = sorted(cols_b - cols_a)
        removed_cols = sorted(cols_a - cols_b)
        if added_cols or removed_cols:
            changed_tables[tid] = {
                "columns_added":   added_cols,
                "columns_removed": removed_cols,
            }

    def edge_key(e: dict) -> tuple:
        return (e["source"], e["target"], e["via"])

    edges_a = {edge_key(e) for e in graph_a["edges"]}
    edges_b = {edge_key(e) for e in graph_b["edges"]}
    added_edges   = [{"source": s, "target": t, "via": v} for s, t, v in sorted(edges_b - edges_a)]
    removed_edges = [{"source": s, "target": t, "via": v} for s, t, v in sorted(edges_a - edges_b)]

    return {
        "from": from_id,
        "to":   to_id,
        "tables": {
            "added":   added_tables,
            "removed": removed_tables,
            "changed": changed_tables,
        },
        "edges": {
            "added":   added_edges,
            "removed": removed_edges,
        },
    }


def read_table_rows(csv_path: Path) -> dict[str, list[str]] | None:
    """Read all data rows from a schema CSV. Returns {row_id: [field_values]} or None if not a schema file.

    Supports modern (7.41+) and legacy (7.3x) header layouts.
    Rows whose first cell is not an integer (type-hint lines, extra headers) are skipped.
    """
    try:
        with open(csv_path, encoding="utf-8-sig", errors="replace", newline="") as f:
            reader = csv.reader(f)
            header = next(reader, None)
            if header is None:
                return None
            if not header[0].startswith("#"):
                if not header[0].startswith("key"):
                    return None
                # Legacy format: skip the 'key,...' line; next line is '#,...'
                header = next(reader, None)
                if header is None or not header[0].startswith("#"):
                    return None
            rows: dict[str, list[str]] = {}
            for row in reader:
                if not row:
                    continue
                try:
                    int(row[0])
                except ValueError:
                    continue  # skip type-hint or extra header rows
                rows[row[0]] = row[1:]
            return rows
    except OSError:
        return None


def build_data_diff(graph_a: dict, graph_b: dict, schema_diff: dict) -> dict:
    """Compare row-level data for tables whose schemas are identical between two versions.

    Tables with schema changes or that only exist in one version are skipped; those counts
    appear in the returned summary. Only tables with at least one row difference are included
    in the output ``tables`` mapping.
    """
    from_id = schema_diff["from"]
    to_id   = schema_diff["to"]

    root_a = Path(graph_a["metadata"]["root"])
    root_b = Path(graph_b["metadata"]["root"])

    schema_a = {n["id"]: n for n in graph_a["nodes"] if n["is_schema"]}
    schema_b = {n["id"]: n for n in graph_b["nodes"] if n["is_schema"]}

    schema_changed = set(schema_diff["tables"]["changed"])
    added_tables   = set(schema_diff["tables"]["added"])
    removed_tables = set(schema_diff["tables"]["removed"])

    in_both    = set(schema_a) & set(schema_b)
    comparable = sorted(in_both - schema_changed)

    result_tables: dict[str, dict] = {}

    for table_id in comparable:
        node_a = schema_a[table_id]
        node_b = schema_b[table_id]

        rows_a = read_table_rows(root_a / node_a["path"])
        rows_b = read_table_rows(root_b / node_b["path"])
        if rows_a is None or rows_b is None:
            continue

        ids_a = set(rows_a)
        ids_b = set(rows_b)

        added_ids   = sorted(ids_b - ids_a, key=_row_sort_key)
        removed_ids = sorted(ids_a - ids_b, key=_row_sort_key)

        col_names = node_a.get("columns", [])[1:]  # skip the leading '#' column header
        rows_changed: dict[str, dict] = {}
        for row_id in sorted(ids_a & ids_b, key=_row_sort_key):
            vals_a = rows_a[row_id]
            vals_b = rows_b[row_id]
            if vals_a == vals_b:
                continue
            field_diffs = {
                col: [va, vb]
                for col, va, vb in zip(col_names, vals_a, vals_b)
                if va != vb
            }
            if field_diffs:
                rows_changed[row_id] = field_diffs

        if added_ids or removed_ids or rows_changed:
            result_tables[table_id] = {
                "rows_added":   [_to_int_id(i) for i in added_ids],
                "rows_removed": [_to_int_id(i) for i in removed_ids],
                "rows_changed": rows_changed,
            }

    return {
        "from": from_id,
        "to":   to_id,
        "summary": {
            "tables_compared":               len(comparable),
            "tables_skipped_schema_changed": len(in_both & schema_changed),
            "tables_skipped_not_in_both":    len(added_tables) + len(removed_tables),
            "tables_with_changes":           len(result_tables),
        },
        "tables": result_tables,
    }


# ── Search index ─────────────────────────────────────────────────────────────

# Column name substrings (case-insensitive) that suggest human-readable name fields.
# Using an allowlist keeps the index focused on searchable names rather than flags/codes.
_NAME_COL_PATTERNS = frozenset({
    "name", "singular", "plural", "title", "label",
})

# Values longer than this are almost certainly prose, not names.
_MAX_VALUE_LEN = 80
# Values shorter than this are likely codes, flags, or single letters.
_MIN_VALUE_LEN = 2


def _is_name_col(col_name: str) -> bool:
    lower = col_name.lower()
    return any(pat in lower for pat in _NAME_COL_PATTERNS)


def _is_numeric(value: str) -> bool:
    if not value:
        return True
    try:
        float(value)
        return True
    except ValueError:
        return False


def build_search_index(graphs: dict[str, dict]) -> dict:
    """Build a deduplicated flat search index of name-like string values across all versions.

    Entries are deduplicated by (table, col, rowId, value): identical values that appear
    in multiple versions are stored once with a list of version IDs.

    Returns a dict with:
      - "fields": column order for each entry
      - "entries": list of [table, col, rowId, value, [versions...]]
    """
    # (table, col, rowId, value) -> set of version IDs
    seen: dict[tuple, set[str]] = {}
    stats: dict[str, int] = {"tables_scanned": 0, "rows_scanned": 0, "values_indexed": 0}

    for version_id, graph in graphs.items():
        root         = Path(graph["metadata"]["root"])
        schema_nodes = [n for n in graph["nodes"] if n["is_schema"]]

        for node in schema_nodes:
            cols = node.get("columns", [])
            if len(cols) < 2:
                continue

            # cols[0] is the "#" row-key header; data_cols aligns with read_table_rows values
            data_cols   = cols[1:]
            include_col = [_is_name_col(c) for c in data_cols]
            if not any(include_col):
                continue

            rows = read_table_rows(root / node["path"])
            if not rows:
                continue

            stats["tables_scanned"] += 1
            stats["rows_scanned"]   += len(rows)

            for row_id, values in rows.items():
                for i, val in enumerate(values):
                    if i >= len(data_cols) or not include_col[i]:
                        continue
                    if not val or _is_numeric(val):
                        continue
                    if len(val) < _MIN_VALUE_LEN or len(val) > _MAX_VALUE_LEN:
                        continue
                    key = (node["id"], data_cols[i], _to_int_id(row_id), val)
                    if key not in seen:
                        seen[key] = set()
                        stats["values_indexed"] += 1
                    seen[key].add(version_id)

    # Serialise: sort versions for deterministic output, use version order from graphs
    version_order = list(graphs.keys())
    entries = [
        [t, c, r, v, sorted(vs, key=lambda x: version_order.index(x) if x in version_order else 99)]
        for (t, c, r, v), vs in seen.items()
    ]

    return {"fields": ["t", "c", "r", "s", "vs"], "entries": entries, "_stats": stats}


def main():
    if not VERSIONS_FILE.exists():
        raise FileNotFoundError(f"{VERSIONS_FILE} not found — create it to register versions")

    versions: list[dict] = json.loads(VERSIONS_FILE.read_text(encoding="utf-8"))
    if not versions:
        raise ValueError("versions.json is empty")

    print(f"Processing {len(versions)} version(s) from {VERSIONS_FILE}...\n")
    SITE_DIR.mkdir(exist_ok=True)

    graphs: dict[str, dict] = {}

    for v in versions:
        vid      = v["id"]
        label    = v.get("label", vid)
        base_dir = find_csv_dir(Path(v["path"]))

        if base_dir is None:
            print(f"[{label}]  SKIPPED — no csv/ directory found under {v['path']}\n")
            continue
        print(f"[{label}]  {base_dir}")

        graph = build_graph(base_dir)
        graphs[vid] = graph

        out_path = Path(f"csv_graph_{vid}.json")
        out_path.write_text(json.dumps(graph, indent=2), encoding="utf-8")
        m = graph["metadata"]
        print(f"  Written -> {out_path}")
        print(f"  {m['total_nodes']} nodes  ({m['schema_nodes']} schema, {m['text_nodes']} text)  ·  {m['total_edges']} edges\n")

    # Diffs between consecutive version pairs (only those successfully processed)
    processed = [v["id"] for v in versions if v["id"] in graphs]
    if len(processed) < 2:
        print("Only one version processed — no diffs to generate.")
        return

    print("Generating diffs...")
    for from_id, to_id in zip(processed, processed[1:]):
        diff     = build_diff(graphs[from_id], graphs[to_id], from_id, to_id)
        out_path = SITE_DIR / f"diff_{from_id}_to_{to_id}.json"
        out_path.write_text(json.dumps(diff, separators=(",", ":")), encoding="utf-8")
        t = diff["tables"]
        e = diff["edges"]
        print(
            f"  {from_id} -> {to_id}  |"
            f"  tables: +{len(t['added'])} added  -{len(t['removed'])} removed  ~{len(t['changed'])} changed  |"
            f"  edges: +{len(e['added'])} -{len(e['removed'])}"
            f"  ->  {out_path}"
        )

        print(f"  Building data diff {from_id} -> {to_id} (reading all rows)...")
        data_diff = build_data_diff(graphs[from_id], graphs[to_id], diff)
        s         = data_diff["summary"]

        # Summary file: only counts per table — keeps the file tiny regardless of row volume.
        summary = {
            "from": from_id,
            "to":   to_id,
            "tables": {
                t: {"ra": len(v["rows_added"]), "rr": len(v["rows_removed"]), "rc": len(v["rows_changed"])}
                for t, v in data_diff["tables"].items()
            },
        }
        data_out_path = SITE_DIR / f"data_diff_{from_id}_to_{to_id}.json"
        data_out_path.write_text(json.dumps(summary, separators=(",", ":")), encoding="utf-8")

        # Per-table detail files: full row data, fetched lazily by the UI.
        # rows_changed is capped to avoid multi-MB files for large tables.
        MAX_ROWS_CHANGED = 2_000
        if data_diff["tables"]:
            detail_dir = SITE_DIR / f"data_diff_{from_id}_to_{to_id}"
            detail_dir.mkdir(exist_ok=True)
            for table_id, table_data in data_diff["tables"].items():
                rc = table_data["rows_changed"]
                if len(rc) > MAX_ROWS_CHANGED:
                    sorted_keys = sorted(rc, key=_row_sort_key)
                    output = {
                        "rows_added":   table_data["rows_added"],
                        "rows_removed": table_data["rows_removed"],
                        "rows_changed": {k: rc[k] for k in sorted_keys[:MAX_ROWS_CHANGED]},
                        "_rc_truncated": len(rc) - MAX_ROWS_CHANGED,
                    }
                else:
                    output = table_data
                (detail_dir / f"{table_id}.json").write_text(
                    json.dumps(output, separators=(",", ":")), encoding="utf-8"
                )

        detail_kb = sum(
            (SITE_DIR / f"data_diff_{from_id}_to_{to_id}" / f"{t}.json").stat().st_size
            for t in data_diff["tables"]
        ) // 1024 if data_diff["tables"] else 0
        print(
            f"  {from_id} -> {to_id} (data)  |"
            f"  compared {s['tables_compared']} tables  |"
            f"  {s['tables_with_changes']} with row changes  |"
            f"  summary {data_out_path.stat().st_size // 1024} KB  |"
            f"  detail {detail_kb} KB ({s['tables_with_changes']} files)"
        )

    print("\nBuilding search index...")
    index      = build_search_index(graphs)
    st         = index.pop("_stats")
    index_path = SITE_DIR / "search_index.json"
    index_path.write_text(json.dumps(index, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    size_kb    = index_path.stat().st_size // 1024
    print(
        f"  {st['tables_scanned']} tables  |"
        f"  {st['rows_scanned']:,} rows scanned  |"
        f"  {st['values_indexed']:,} values indexed  |"
        f"  {size_kb} KB  ->  {index_path}"
    )


if __name__ == "__main__":
    main()
