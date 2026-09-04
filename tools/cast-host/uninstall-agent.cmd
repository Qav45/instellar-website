@echo off
setlocal
set "TASK=InstellarCastAgent"
schtasks /query /tn "%TASK%" >nul 2>&1
if errorlevel 1 goto :missing
if not exist "%USERPROFILE%\.instellar-cast" mkdir "%USERPROFILE%\.instellar-cast" >nul 2>&1
>"%USERPROFILE%\.instellar-cast\agent.stop" echo stop
powershell -NoProfile -Command "Start-Sleep -Seconds 11"
schtasks /end /tn "%TASK%" >nul 2>&1
schtasks /delete /tn "%TASK%" /f >nul 2>&1
if errorlevel 1 goto :fail
echo Stopped and removed %TASK%.
exit /b 0

:missing
echo %TASK% was not installed.
exit /b 0

:fail
echo Could not remove %TASK%.
exit /b 1
