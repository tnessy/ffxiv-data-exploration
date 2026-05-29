$python = ".venv\Scripts\python.exe"

Write-Host "=== Generating version graphs and diffs ===" -ForegroundColor Cyan
& $python generate_csv_graph.py
if (-not $?) { Write-Host "generate_csv_graph.py failed" -ForegroundColor Red; exit 1 }

Write-Host ""
Write-Host "=== Generating visualization ===" -ForegroundColor Cyan
& $python generate_viz.py
if (-not $?) { Write-Host "generate_viz.py failed" -ForegroundColor Red; exit 1 }

Write-Host ""
Write-Host "=== Copying latest CSV data into site/ ===" -ForegroundColor Cyan
& $python -c @"
import json, shutil, pathlib
root = json.loads(pathlib.Path('csv_graph_latest.json').read_text(encoding='utf-8'))['metadata']['root']
src = pathlib.Path(root)
dst = pathlib.Path('site') / root
if dst.exists():
    shutil.rmtree(dst)
dst.parent.mkdir(parents=True, exist_ok=True)
shutil.copytree(src, dst)
print(f'Copied {src} -> {dst}')
"@
if (-not $?) { Write-Host "CSV copy failed" -ForegroundColor Red; exit 1 }

Write-Host ""
Write-Host "Done. To test locally:" -ForegroundColor Green
Write-Host "  python -m http.server --directory site" -ForegroundColor Yellow
Write-Host "  Then open http://localhost:8000" -ForegroundColor Yellow
Write-Host ""
Write-Host "Deployable artifacts in site/:" -ForegroundColor DarkGray
Write-Host "  index.html            - the UI" -ForegroundColor DarkGray
Write-Host "  diff_*.json           - schema diffs (fetched on demand)" -ForegroundColor DarkGray
Write-Host "  data_diff_*.json      - row-level diffs (fetched on demand)" -ForegroundColor DarkGray
Write-Host "  ffxiv-datamining-*/   - latest CSV data (fetched on demand)" -ForegroundColor DarkGray
Write-Host "  (csv_graph_*.json stay in root - generation intermediates only)" -ForegroundColor DarkGray
