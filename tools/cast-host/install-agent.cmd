@echo off
setlocal
set "TASK=InstellarCastAgent"
set "AGENT=%~dp0cast-agent.mjs"
set "ARGS=%*"
for %%N in (node.exe) do set "NODE=%%~$PATH:N"
if not defined NODE (
  echo Could not find node.exe on PATH. Install Node 18 or newer first.
  exit /b 1
)
REM schtasks wants the quotes inside /tr escaped with backslashes, and a
REM quoted set keeps the backslashes and inner quotes literal - carets did not
REM survive the trip and split the path at "Program Files".
set "RUN=\"%NODE%\" \"%AGENT%\" %ARGS%"

schtasks /create /tn "%TASK%" /sc onlogon /rl limited /f /tr "%RUN%" >nul || goto :fail
powershell -NoProfile -Command "$s=New-ScheduledTaskSettingsSet -Hidden -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1); Set-ScheduledTask -TaskName '%TASK%' -Settings $s | Out-Null" || goto :fail
schtasks /run /tn "%TASK%" >nul || goto :fail
echo Installed and started %TASK%.
echo It will run hidden at logon as %USERNAME% and restart after failures.
exit /b 0

:fail
echo Could not install or start %TASK%.
exit /b 1
