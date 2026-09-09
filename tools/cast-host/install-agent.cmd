@echo off
REM Install the cast agent as a hidden logon task for the current user, so the
REM site can start a cast on this machine with nobody at the keyboard.
REM Any extra arguments are passed to the agent, and through it to cast-host
REM (so install-agent.cmd --lan gives every cast the LAN link too).
setlocal
set "TASK=InstellarCastAgent"
set "AGENT=%~dp0cast-agent.mjs"
set "ARGS=%*"
set "POLLFILE=%ProgramData%\instellar-cast\poll-ms"
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

REM The whole point of the agent is that nobody has to be standing at this
REM machine later - which also makes this the last moment anyone is here to
REM answer a UAC prompt. TightVNC ships polling the screen once a second, so
REM a host provisioned purely through the agent casts at 1 FPS forever unless
REM someone runs the tuner, and that presents as a bad network rather than as
REM a setting. tune-host.cmd records the interval it applied in POLLFILE, so
REM a second install does not nag.
if exist "%POLLFILE%" goto :tuned
echo.
echo TightVNC polls the screen once a second out of the box, which caps every
echo cast from this machine at 1 FPS however fast the link is. tune-host.cmd
echo drops that to 30 ms. It needs administrator rights, so it will ask.
set "ANS="
set /p "ANS=Run tune-host.cmd now? [y/N] "
REM First letter only, so y/Y/yes all mean yes. Everything else skips - including
REM the empty answer set /p returns straight away when nobody is at the keyboard,
REM because the other branch opens a UAC prompt there would be no one to answer.
if /i not "%ANS:~0,1%"=="y" (
  echo Skipped. Casts stay capped at 1 FPS until you run:
  echo   "%~dp0tune-host.cmd"
  exit /b 0
)
REM tune-host.cmd relaunches itself elevated and returns straight away, so
REM the tuning and its output happen in the window UAC opens, not this one.
call "%~dp0tune-host.cmd"
exit /b 0

:tuned
for /f "usebackq" %%M in ("%POLLFILE%") do set "POLL=%%M"
echo TightVNC polling is already tuned to %POLL% ms. Run tune-host.cmd to change it.
exit /b 0

:fail
echo Could not install or start %TASK%.
exit /b 1
