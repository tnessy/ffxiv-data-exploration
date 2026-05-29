"""
Generates the deployable site from source files.
Run from project root:  python generate_viz.py
Requires:               csv_graph_latest.json  (from generate_csv_graph.py)
                        versions.json          (version registry)
                        graph_viz_template.html
                        src/styles.css
                        src/app.js
Output (all in site/):  index.html, styles.css, app.js, data.js
"""
import json
import re
import shutil
from collections import Counter
from pathlib import Path

GRAPH_FILE    = Path("csv_graph_latest.json")
TEMPLATE_FILE = Path("graph_viz_template.html")
SRC_DIR       = Path("src")
SITE_DIR      = Path("site")
VERSIONS_FILE = Path("versions.json")


def get_family(name: str) -> str:
    parts = re.findall(r'[A-Z]+(?=[A-Z][a-z])|[A-Z][a-z]*', name)
    if not parts:
        return name
    return (parts[0] + parts[1]) if len(parts) >= 2 and len(parts[0]) == 1 else parts[0]


def main():
    graph = json.loads(GRAPH_FILE.read_text(encoding="utf-8"))

    SITE_DIR.mkdir(exist_ok=True)

    schema_nodes = [n for n in graph["nodes"] if n["is_schema"]]
    edges = graph["edges"]

    connected_ids: set[str] = set()
    for e in edges:
        connected_ids.add(e["source"])
        connected_ids.add(e["target"])

    viz_nodes = []
    for n in schema_nodes:
        viz_nodes.append({
            "id":        n["id"],
            "family":    get_family(n["id"]),
            "connected": n["id"] in connected_ids,
            "columns":   n.get("columns", []),
            "path":      n["path"],
        })

    family_counts = Counter(n["family"] for n in viz_nodes)
    top_families = [f for f, _ in family_counts.most_common(15)]

    # Collect version list and available diff pairs for the UI.
    versions_meta: list[dict] = []
    diff_pairs: list[dict] = []
    data_diff_pairs: list[dict] = []
    if VERSIONS_FILE.exists():
        raw_versions = json.loads(VERSIONS_FILE.read_text(encoding="utf-8"))
        versions_meta = [{"id": v["id"], "label": v.get("label", v["id"])} for v in raw_versions]
        for a, b in zip(raw_versions, raw_versions[1:]):
            from_id, to_id = a["id"], b["id"]
            if (SITE_DIR / f"diff_{from_id}_to_{to_id}.json").exists():
                diff_pairs.append({"from": from_id, "to": to_id})
            if (SITE_DIR / f"data_diff_{from_id}_to_{to_id}.json").exists():
                data_diff_pairs.append({"from": from_id, "to": to_id})

    data = {
        "nodes": viz_nodes,
        "edges": edges,
        "meta": {
            "top_families":    top_families,
            "total_families":  len(family_counts),
            "versions":        versions_meta,
            "diff_pairs":      diff_pairs,
            "data_diff_pairs": data_diff_pairs,
        },
    }

    # Write data.js — the only file that changes between builds
    data_json = json.dumps(data, separators=(",", ":"))
    (SITE_DIR / "data.js").write_text(f"const RAW = {data_json};", encoding="utf-8")

    # Copy static source files
    shutil.copy(SRC_DIR / "styles.css", SITE_DIR / "styles.css")
    shutil.copy(SRC_DIR / "app.js",     SITE_DIR / "app.js")

    # Copy HTML template as index.html (no injection needed)
    shutil.copy(TEMPLATE_FILE, SITE_DIR / "index.html")

    connected_count = sum(1 for n in viz_nodes if n["connected"])
    index_kb = (SITE_DIR / "index.html").stat().st_size // 1024
    data_kb  = (SITE_DIR / "data.js").stat().st_size // 1024
    print(f"Written to {SITE_DIR}/")
    print(f"  index.html  : {index_kb} KB")
    print(f"  data.js     : {data_kb} KB  ({len(viz_nodes)} nodes, {len(edges)} edges)")
    print(f"  styles.css  : {(SITE_DIR / 'styles.css').stat().st_size // 1024} KB")
    print(f"  app.js      : {(SITE_DIR / 'app.js').stat().st_size // 1024} KB")
    print(f"  Schema nodes: {len(viz_nodes)} ({connected_count} connected, {len(viz_nodes)-connected_count} isolated)")
    print(f"  Families    : {len(family_counts)} ({len(top_families)} shown in legend)")
    print(f"  CSV rows    : loaded dynamically at runtime via fetch()")


if __name__ == "__main__":
    main()