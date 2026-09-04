@echo off
REM Lower TightVNC's screen polling interval, which is the single biggest cause
REM of a cast that feels laggy while the network says it is fine.
REM
REM TightVNC learns that the screen changed in two ways: hooks, which only see
REM the old GDI drawing path, and a full-screen poll for everything else. Chrome,
REM Electron apps, video and anything composited land in "everything else", so
REM they update at the poll rate - and that rate ships at 1000 ms. One frame a
REM second is not a slow link, it is a slow camera, and no amount of quality or
REM bandwidth tuning in the browser can make up for it.
REM
REM Usage: tune-host.cmd [interval-ms]   (default 100, TightVNC's own floor is 30)
REM
REM The setting lives under HKLM, which only an administrator may read or write,
REM so this asks for elevation. Nothing else here needs it.
setlocal
set "MS=%~1"
if not defined MS set "MS=100"
REM TightVNC refuses anything under 30 in its own settings dialog, so do not
REM write a number it will not honour.
set /a MS=%MS% 2>nul >nul
if %MS% LSS 30 set "MS=30"
set "KEY=HKLM\SOFTWARE\TightVNC\Server"
set "TVN=C:\Program Files\TightVNC\tvnserver.exe"

net session >nul 2>&1
if errorlevel 1 (
  echo Asking for administrator rights...
  powershell -NoProfile -Command "Start-Process -Verb RunAs -FilePath '%~f0' -ArgumentList '%MS%'" || goto :fail
  exit /b 0
)

if not exist "%TVN%" (
  echo Could not find TightVNC at "%TVN%".
  goto :fail
)

REM No pipe into find here on purpose: this can be run from a shell whose PATH
REM puts a Unix find ahead of the Windows one, and that one reads the arguments
REM as filenames. reg query's own output has nothing else with three tokens.
for /f "tokens=3" %%V in ('reg query "%KEY%" /v PollingInterval 2^>nul') do set "WAS=%%V"
if defined WAS (set /a WASMS=%WAS% >nul) else (set "WASMS=")
if defined WASMS (echo Polling interval was %WASMS% ms.) else (echo No polling interval was set, so TightVNC was using its 1000 ms default.)

reg add "%KEY%" /v PollingInterval /t REG_DWORD /d %MS% /f >nul || goto :fail
REM Reload rather than restart: restarting the service drops any cast that is
REM running, and the setting is one the service re-reads on its own.
"%TVN%" -controlservice -reload
echo.
echo Polling interval is now %MS% ms. Casts should track moving windows and
echo video far more closely. If this machine is not doing anything else while
echo it casts, 50 is smoother still; if the fan starts up, put it back to 200.
pause
exit /b 0

:fail
echo Could not change the polling interval.
pause
exit /b 1
