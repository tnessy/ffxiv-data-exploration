"""
Generates a self-contained D3 visualization from csv_graph.json.
Run from project root:  python generate_viz.py
Requires:               csv_graph.json  (from generate_csv_graph.py)
Output:                 graph_viz.html  (serve via HTTP — e.g. python -m http.server)

CSV row data is loaded dynamically at runtime via fetch(), so the HTML stays small.
"""
import json
import re
from collections import Counter
from pathlib import Path

GRAPH_FILE    = Path("csv_graph.json")
TEMPLATE_FILE = Path("graph_viz_template.html")
OUTPUT_FILE   = Path("graph_viz.html")

# This exact string in the template is replaced with real data.
DATA_MARKER = '{"nodes":[],"edges":[]}; // __INJECT_DATA__'


def get_family(name: str) -> str:
    parts = re.findall(r'[A-Z]+(?=[A-Z][a-z])|[A-Z][a-z]*', name)
    if not parts:
        return name
    return (parts[0] + parts[1]) if len(parts) >= 2 and len(parts[0]) == 1 else parts[0]


def main():
    graph = json.loads(GRAPH_FILE.read_text(encoding="utf-8"))
    template = TEMPLATE_FILE.read_text(encoding="utf-8")

    if DATA_MARKER not in template:
        raise ValueError(f"Data marker not found in {TEMPLATE_FILE}")

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

    data = {
        "nodes": viz_nodes,
        "edges": edges,
        "meta": {
            "top_families":    top_families,
            "total_families":  len(family_counts),
        },
    }
    data_json = json.dumps(data, separators=(",", ":"))
    data_json = data_json.replace("</script>", r"<\/script>")

    OUTPUT_FILE.write_text(template.replace(DATA_MARKER, f"{data_json};"), encoding="utf-8")

    connected_count = sum(1 for n in viz_nodes if n["connected"])
    file_kb = OUTPUT_FILE.stat().st_size // 1024
    print(f"Written to {OUTPUT_FILE} ({file_kb} KB)")
    print(f"  Schema nodes : {len(viz_nodes)} ({connected_count} connected, {len(viz_nodes)-connected_count} isolated)")
    print(f"  Edges        : {len(edges)}")
    print(f"  Families     : {len(family_counts)} ({len(top_families)} shown in legend)")
    print(f"  CSV rows     : loaded dynamically at runtime via fetch()")


if __name__ == "__main__":
    main()
