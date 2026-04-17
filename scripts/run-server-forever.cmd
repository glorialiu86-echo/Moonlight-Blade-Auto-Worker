@echo off
setlocal

set "ROOT=%~dp0.."
set "LOG_DIR=%ROOT%\tmp\service-logs"
set "NODE_EXE=C:\Program Files\nodejs\node.exe"

if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"

cd /d "%ROOT%"

:restart
echo [%date% %time%] starting server >> "%LOG_DIR%\server.log"
"%NODE_EXE%" src\server\index.js >> "%LOG_DIR%\server.log" 2>&1
echo [%date% %time%] server exited with code %errorlevel%, restarting in 5 seconds >> "%LOG_DIR%\server.log"
timeout /t 5 /nobreak >nul
goto restart
