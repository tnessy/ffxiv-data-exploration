$python = ".venv\Scripts\python.exe"

Write-Host "=== Generating version graphs and diffs ===" -ForegroundColor Cyan
& $python generate_csv_graph.py
if (-not $?) { Write-Host "generate_csv_graph.py failed" -ForegroundColor Red; exit 1 }

Write-Host ""
Write-Host "=== Generating visualization ===" -ForegroundColor Cyan
& $python generate_viz.py
if (-not $?) { Write-Host "generate_viz.py failed" -ForegroundColor Red; exit 1 }

Write-Host ""
Write-Host "Done." -ForegroundColor Green
