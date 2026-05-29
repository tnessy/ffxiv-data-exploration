"""
Generates per-version JSON graphs of relationships between FFXIV datamining CSV files,
then produces diffs between each consecutive version pair.

Versions are registered in versions.json at the project root.

Run from the project root:
    python generate_csv_graph.py

Outputs (one per version):
    csv_graph_{version_id}.json

Outputs (one per consecutive pair):
    diff_{from_id}_to_{to_id}.json      — schema + edge diffs
    data_diff_{from_id}_to_{to_id}.json — row-level data diffs for tables with stable schemas
"""
import csv
import json
from datetime import datetime, timezone
from pathlib import Path

VERSIONS_FILE = Path("versions.json")
CSV_SUBDIR    = Path("csv/en")


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
    """Return column list if the file is a schema table (first line starts with '#'), else None."""
    try:
        with open(csv_path, encoding="utf-8", errors="replace") as f:
            first_line = f.readline().rstrip("\n")
    except OSError:
        return None
    if not first_line.startswith("#"):
        return None
    return next(csv.reader([first_line]))


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

    Rows whose first cell is not an integer (e.g. type-hint lines in some formats) are skipped.
    """
    try:
        with open(csv_path, encoding="utf-8", errors="replace", newline="") as f:
            reader = csv.reader(f)
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


def main():
    if not VERSIONS_FILE.exists():
        raise FileNotFoundError(f"{VERSIONS_FILE} not found — create it to register versions")

    versions: list[dict] = json.loads(VERSIONS_FILE.read_text(encoding="utf-8"))
    if not versions:
        raise ValueError("versions.json is empty")

    print(f"Processing {len(versions)} version(s) from {VERSIONS_FILE}...\n")

    graphs: dict[str, dict] = {}

    for v in versions:
        vid      = v["id"]
        label    = v.get("label", vid)
        base_dir = Path(v["path"]) / CSV_SUBDIR

        print(f"[{label}]  {base_dir}")
        if not base_dir.exists():
            print(f"  SKIPPED — path not found\n")
            continue

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
        out_path = Path(f"diff_{from_id}_to_{to_id}.json")
        out_path.write_text(json.dumps(diff, indent=2), encoding="utf-8")
        t = diff["tables"]
        e = diff["edges"]
        print(
            f"  {from_id} -> {to_id}  |"
            f"  tables: +{len(t['added'])} added  -{len(t['removed'])} removed  ~{len(t['changed'])} changed  |"
            f"  edges: +{len(e['added'])} -{len(e['removed'])}"
            f"  ->  {out_path}"
        )

        print(f"  Building data diff {from_id} -> {to_id} (reading all rows)...")
        data_diff     = build_data_diff(graphs[from_id], graphs[to_id], diff)
        data_out_path = Path(f"data_diff_{from_id}_to_{to_id}.json")
        data_out_path.write_text(json.dumps(data_diff, indent=2), encoding="utf-8")
        s = data_diff["summary"]
        print(
            f"  {from_id} -> {to_id} (data)  |"
            f"  compared {s['tables_compared']} tables  |"
            f"  {s['tables_with_changes']} with row changes  |"
            f"  skipped: {s['tables_skipped_schema_changed']} schema-changed, {s['tables_skipped_not_in_both']} not-in-both"
            f"  ->  {data_out_path}"
        )


if __name__ == "__main__":
    main()
