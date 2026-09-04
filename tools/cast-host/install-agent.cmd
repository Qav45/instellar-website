@echo off
REM Install the cast agent as a hidden logon task for the current user, so the
REM site can start a cast on this machine with nobody at the keyboard.
REM Any extra arguments are passed to the agent, and through it to cast-host
REM (so install-agent.cmd --lan gives every cast the LAN link too).
setlocal
set "TASK=InstellarCastAgent"
set "AGENT=%~dp0cast-agent.mjs"
set "ARGS=%*"
for %%N in (node.exe) do set "NODE=%%~$PATH:N"
if not defined NODE (
  echo Could not find node.exe on PATH. Install Node 18 or newer first.
  exit /b 1
)

REM Register-ScheduledTask rather than schtasks /create: a logon trigger through
REM schtasks is "Access is denied" from an ordinary prompt, and this must not
REM need an elevated one. No execution time limit, or Windows ends the agent
REM after three days for the crime of still running.
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$a = New-ScheduledTaskAction -Execute '%NODE%' -Argument ('\"%AGENT%\" ' + '%ARGS%').Trim();" ^
  "$t = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME;" ^
  "$s = New-ScheduledTaskSettingsSet -Hidden -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero);" ^
  "Register-ScheduledTask -TaskName '%TASK%' -Action $a -Trigger $t -Settings $s -Force | Out-Null" || goto :fail
schtasks /run /tn "%TASK%" >nul || goto :fail
echo Installed and started %TASK%.
echo It runs hidden at logon as %USERNAME% and restarts after failures.
echo Logs: %USERPROFILE%\.instellar-cast\agent.log and cast.log
exit /b 0

:fail
echo Could not install or start %TASK%.
exit /b 1
