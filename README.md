# FFXIV Data Exploration

A browser-based tool for exploring FFXIV datamining CSVs — visualize table relationships, browse row data, and diff schema/data changes between game versions.

## Prerequisites

- Python 3.12+ with a virtualenv at `.venv/`
- Game data submodules checked out (run `git submodule update --init --recursive`)

Set up the virtualenv once:
```powershell
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt  # if present
```

## Adding a new game version

1. Add the submodule:
   ```powershell
   git submodule add https://github.com/xivapi/ffxiv-datamining.git ffxiv-datamining-<version>
   cd ffxiv-datamining-<version>
   git checkout <commit>
   cd ..
   ```
2. Register it in `versions.json` (in chronological order):
   ```json
   { "id": "7.51", "label": "7.51", "path": "ffxiv-datamining-7.51", "date": null }
   ```
3. Run `update.ps1` to regenerate everything.

## Local development

```powershell
.\update.ps1
python -m http.server --directory site
```

Then open **http://localhost:8000**.

`update.ps1` runs the same steps as the CI deploy:
1. `generate_csv_graph.py` — builds per-version graphs and diffs → `site/diff_*.json`, `site/data_diff_*.json`
2. `generate_viz.py` — injects graph data into the HTML template → `site/index.html`
3. Copies the latest CSV data into `site/` so row data loads at runtime

## Deployment

Pushing to `main` triggers `.github/workflows/deploy.yml`, which runs the same three steps and publishes `site/` to the `gh-pages` branch via `peaceiris/actions-gh-pages`.

## Project structure

```
versions.json              — ordered registry of game versions
graph_viz_template.html    — HTML/JS template for the UI
generate_csv_graph.py      — builds graphs and diffs from CSV submodules
generate_viz.py            — renders template + graph data → site/index.html
update.ps1                 — local build script (mirrors CI)

site/                      — build output (gitignored, deployed to gh-pages)
  index.html
  diff_<from>_to_<to>.json
  data_diff_<from>_to_<to>.json
  ffxiv-datamining-latest/

csv_graph_*.json           — build intermediates (gitignored)
ffxiv-datamining-*/        — version submodules (CSV source data)
```