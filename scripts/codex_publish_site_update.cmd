@echo off
setlocal
cd /d "%~dp0.."
node scripts\codex_publish_site_update.mjs %*
exit /b %ERRORLEVEL%
