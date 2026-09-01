@echo off
REM Start casting this machine to instellar.net/cool-things/cast.
REM Any extra arguments are passed straight through to cast-host.mjs.
setlocal
cd /d "%~dp0"
node cast-host.mjs %*
endlocal
