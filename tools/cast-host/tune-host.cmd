@echo off
REM VNC+ host tuning. Nothing runs this for you: it is only ever typed by a
REM person, it never starts or stops a service, and by default it does not
REM contact a running tvnserver at all.
REM
REM What this used to say, and why it was only half right:
REM
REM   "TightVNC learns that the screen changed in two ways: hooks, which only
REM   see the old GDI drawing path, and a full-screen poll for everything else.
REM   ... that rate ships at 1000 ms."
REM
REM That describes TightVNC's *fallback* capture path. Reading TightVNC 2.8.88's
REM source, Win32ScreenDriverFactory::createScreenDriver tries the Windows 8
REM desktop duplication driver first and only falls back to the mirror driver
REM and then to the hooks-and-poll driver. The duplication driver is an
REM unthrottled AcquireNextFrame loop that is handed dirty and move rectangles
REM by the GPU - the same mechanism the /cast video path uses through ffmpeg's
REM ddagrab - and PollingInterval is a member of the polling driver only, so it
REM has no effect at all while duplication is working.
REM
REM So the lever that actually decides frames per second on Windows 10 and 11 is
REM UseD3D, not PollingInterval. UseD3D ships as 1, but it is a plain HKLM value
REM that a settings dialog or an old profile can turn off, and when it is off
REM there is nothing anywhere saying so - the cast just goes quiet and slow.
REM This sets both: UseD3D so the fast path is allowed, and PollingInterval so
REM the slow path is survivable on the days duplication cannot start.
REM
REM Usage: tune-host.cmd [interval-ms] [reload]
REM
REM   interval-ms  fallback polling rate, default 30 (TightVNC's own floor)
REM   reload       also ask tvnserver to re-read its settings. Off by default:
REM                the reload talks to the live service, and this file is often
REM                typed while someone is watching a cast. Without it the values
REM                are written and take effect the next time the server starts.
REM
REM The settings live under HKLM, which only an administrator may read or write,
REM so this asks for elevation. Nothing else here needs it.
setlocal
set "MS=%~1"
set "RELOAD=%~2"
if not defined MS set "MS=30"
REM TightVNC refuses anything under 30 in its own settings dialog, so do not
REM write a number it will not honour.
set /a MS=%MS% 2>nul >nul
if %MS% LSS 30 set "MS=30"
set "KEY=HKLM\SOFTWARE\TightVNC\Server"
REM Both Program Files folders, in the order cast-host.mjs probes them: a
REM 32-bit TightVNC on 64-bit Windows is a perfectly ordinary install, and a
REM tuner that cannot find the server the bridge is already driving looks
REM broken when the machine is merely misconfigured.
set "TVN="
for %%P in (
  "C:\Program Files\TightVNC\tvnserver.exe"
  "C:\Program Files (x86)\TightVNC\tvnserver.exe"
) do if not defined TVN if exist %%P set "TVN=%%~P"

net session >nul 2>&1
if errorlevel 1 (
  echo Asking for administrator rights...
  powershell -NoProfile -Command "Start-Process -Verb RunAs -FilePath '%~f0' -ArgumentList '%MS%','%RELOAD%'" || goto :fail
  exit /b 0
)

if not defined TVN (
  echo Could not find tvnserver.exe in either Program Files folder.
  goto :fail
)

REM No pipe into find here on purpose: this can be run from a shell whose PATH
REM puts a Unix find ahead of the Windows one, and that one reads the arguments
REM as filenames. reg query's own output has nothing else with three tokens.
for /f "tokens=3" %%V in ('reg query "%KEY%" /v UseD3D 2^>nul') do set "D3D=%%V"
if defined D3D (set /a D3DN=%D3D% >nul) else (set "D3DN=")
if not defined D3DN (
  echo Desktop duplication was not configured either way, so TightVNC was using
  echo its default, which is on.
) else if %D3DN% EQU 0 (
  echo Desktop duplication was turned OFF. That is the whole cast's frame rate:
  echo with it off TightVNC falls back to hooks and a full-screen poll, and
  echo anything composited - Chrome, Electron apps, video - moves at the poll
  echo rate instead of at the rate the screen is actually changing.
) else (
  echo Desktop duplication was already on.
)

for /f "tokens=3" %%V in ('reg query "%KEY%" /v PollingInterval 2^>nul') do set "WAS=%%V"
if defined WAS (set /a WASMS=%WAS% >nul) else (set "WASMS=")
if defined WASMS (echo Fallback polling interval was %WASMS% ms.) else (echo No polling interval was set, so the fallback path was using TightVNC's 1000 ms default.)

reg add "%KEY%" /v UseD3D /t REG_DWORD /d 1 /f >nul || goto :fail
reg add "%KEY%" /v PollingInterval /t REG_DWORD /d %MS% /f >nul || goto :fail

REM Leave the applied value where the bridge can read it. HKLM is
REM administrator-only even to read, so cast-host - which runs unelevated -
REM cannot ask the registry what the interval is, and a host nobody tuned is
REM otherwise silently capped at 1 FPS on the fallback path with nothing
REM anywhere saying so. Anything created under ProgramData is readable by
REM everyone by inheritance, so no ACL work is needed. Redirect before echo, or
REM the value picks up a trailing space.
set "STATE=%ProgramData%\instellar-cast"
if not exist "%STATE%" mkdir "%STATE%" >nul 2>&1
>"%STATE%\poll-ms" echo %MS%
if errorlevel 1 echo Note: could not write "%STATE%\poll-ms", so the cast toolbar cannot report the interval.

echo.
echo Desktop duplication is allowed, and the fallback polling interval is now
echo %MS% ms. At 30 ms the fallback capture ceiling is about 33 FPS; with
echo duplication working there is no interval and no ceiling from capture.

if /i not "%RELOAD%"=="reload" (
  echo.
  echo Both values are written but the running server has not been told.
  echo It will pick them up the next time it starts. To apply them now - which
  echo talks to the live service, so do not do it mid-cast:
  echo   "%TVN%" -controlservice -reload
  echo or run this again as:  tune-host.cmd %MS% reload
  pause
  exit /b 0
)

REM Reload rather than restart: restarting the service drops any cast that is
REM running, and these are settings the service re-reads on its own. The reload
REM is also the half that changes anything - without it the values sit in the
REM registry while the server keeps capturing the old way - so it is checked
REM like every other fallible line here rather than assumed.
"%TVN%" -controlservice -reload
if errorlevel 1 (
  echo.
  echo The values are written, but tvnserver would not take the reload - most
  echo often because the service is not running - so it is still capturing the
  echo old way. Restart the tvnserver service to pick them up:
  echo   net stop tvnserver ^&^& net start tvnserver
  echo A restart drops any cast that is running.
  pause
  exit /b 1
)

echo Settings reloaded.
pause
exit /b 0

:fail
echo Could not change the capture settings.
pause
exit /b 1
