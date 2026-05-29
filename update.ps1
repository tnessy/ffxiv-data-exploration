$python = ".venv\Scripts\python.exe"

Write-Host "=== Generating version graphs and diffs ===" -ForegroundColor Cyan
& $python generate_csv_graph.py
if (-not $?) { Write-Host "generate_csv_graph.py failed" -ForegroundColor Red; exit 1 }

Write-Host ""
Write-Host "=== Generating visualization ===" -ForegroundColor Cyan
& $python generate_viz.py
if (-not $?) { Write-Host "generate_viz.py failed" -ForegroundColor Red; exit 1 }

Write-Host ""
Write-Host "Done. Deployable artifacts written to site/" -ForegroundColor Green
Write-Host "  site/index.html       — the UI" -ForegroundColor DarkGray
Write-Host "  site/diff_*.json      — schema diffs (fetched on demand)" -ForegroundColor DarkGray
Write-Host "  site/data_diff_*.json — row-level diffs (fetched on demand)" -ForegroundColor DarkGray
Write-Host "  (csv_graph_*.json stay in root — generation intermediates only)" -ForegroundColor DarkGray
