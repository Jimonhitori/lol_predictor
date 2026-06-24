@echo off
setlocal

set "ROOT=%~dp0.."
set "ANALYZER=%ROOT%\lol-pros-analyzer"
set "PY=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"

if not exist "%PY%" (
  set "PY=python"
)

pushd "%ANALYZER%" || exit /b 1

echo Fetching LoL Esports schedule including TBD matches...
"%PY%" scripts\fetch_lolesports_schedule.py --days 14 --include-tbd --output data\processed\lolesports_schedule.csv
if errorlevel 1 goto failed

echo Exporting site schedule artifacts...
"%PY%" scripts\export_site_schedule.py --schedule data\processed\lolesports_schedule.csv --site-docs-dir "%ROOT%\docs" --base-site-docs-dir "%ROOT%\docs"
if errorlevel 1 goto failed

popd
echo Done.
exit /b 0

:failed
popd
echo Schedule update failed.
exit /b 1
