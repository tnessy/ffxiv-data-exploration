"""
Generates a JSON graph of relationships between FFXIV datamining CSV files.

Nodes  — every CSV file found under BASE_DIR
Edges  — a column name in table A exactly matches the stem of table B,
         indicating a foreign-key-style reference from A to B

Run from the project root:
    python generate_csv_graph.py
"""
import csv
import json
from datetime import datetime, timezone
from pathlib import Path

BASE_DIR = Path("ffxiv-datamining/csv/en")
OUTPUT_FILE = Path("csv_graph.json")


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
    print(f"Found {len(all_paths)} CSV files, reading headers...")

    # Collect metadata for every file; track duplicate stems so we can warn
    tables: dict[str, dict] = {}
    duplicate_stems: set[str] = set()

    for csv_path in all_paths:
        stem = csv_path.stem
        rel_path = csv_path.relative_to(base_dir).as_posix()
        rel_dir = csv_path.parent.relative_to(base_dir).as_posix()
        columns = read_schema_columns(csv_path)

        if stem in tables:
            duplicate_stems.add(stem)
        else:
            tables[stem] = {
                "path": rel_path,
                "dir": rel_dir,
                "columns": columns,
            }

    if duplicate_stems:
        print(f"Warning: {len(duplicate_stems)} duplicate stem(s) detected — only first occurrence kept:")
        for s in sorted(duplicate_stems):
            print(f"  {s}")

    all_stems = set(tables)
    nodes: list[dict] = []
    edges: list[dict] = []

    for stem, info in tables.items():
        node: dict = {
            "id": stem,
            "path": info["path"],
            "dir": info["dir"],
            "is_schema": info["columns"] is not None,
        }
        if info["columns"] is not None:
            node["columns"] = info["columns"]
        nodes.append(node)

        if info["columns"]:
            for col in info["columns"]:
                # Only plain column names (no array notation, no dot paths) can match a table stem
                if col in all_stems and col != stem:
                    edges.append({"source": stem, "target": col, "via": col})

    schema_count = sum(1 for n in nodes if n["is_schema"])
    return {
        "metadata": {
            "generated": datetime.now(timezone.utc).isoformat(),
            "root": base_dir.as_posix(),
            "total_nodes": len(nodes),
            "schema_nodes": schema_count,
            "text_nodes": len(nodes) - schema_count,
            "total_edges": len(edges),
            "duplicate_stems_skipped": sorted(duplicate_stems),
        },
        "nodes": nodes,
        "edges": edges,
    }


if __name__ == "__main__":
    graph = build_graph(BASE_DIR)
    OUTPUT_FILE.write_text(json.dumps(graph, indent=2), encoding="utf-8")
    m = graph["metadata"]
    print(
        f"Graph: {m['total_nodes']} nodes "
        f"({m['schema_nodes']} schema, {m['text_nodes']} text/localization), "
        f"{m['total_edges']} edges"
    )
    print(f"Written to {OUTPUT_FILE}")
