@echo off
rem ============================================================================
rem  Wrapper para el Programador de tareas de Windows.
rem  Corre el pipeline Stephy en modo AUTOMATICO (sin esperar Enter) y guarda
rem  un log con timestamp en data\auto-runs.log.
rem
rem  Tareas que lo invocan:
rem    - MamaSAN-Stephy-AM : lun-vie 10:30
rem    - MamaSAN-Stephy-PM : todos los dias 18:30
rem ============================================================================
setlocal
set "PROJ=C:\Users\MMS Server\Desktop\MamaSAN\Stagehand\stagehand-stephy"
set "PATH=C:\Program Files\nodejs;C:\Users\MMS Server\AppData\Local\pnpm\bin;%PATH%"
cd /d "%PROJ%"

rem -- Matar cualquier Chrome del perfil stephy para evitar el lock del perfil --
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | Where-Object { $_.CommandLine -like '*stagehand-stephy*chrome-user-data*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }" >nul 2>&1

rem -- #12 Rotacion del log: si auto-runs.log supera 5 MB, lo movemos a .1 (una
rem    sola generacion vieja) para que no crezca sin tope. --
if exist "data\auto-runs.log" (
  for %%A in ("data\auto-runs.log") do if %%~zA GTR 5242880 (
    if exist "data\auto-runs.log.1" del "data\auto-runs.log.1"
    move /y "data\auto-runs.log" "data\auto-runs.log.1" >nul
  )
)

echo ============================================================ >> "data\auto-runs.log"
echo [%date% %time%] iniciando stephy:auto >> "data\auto-runs.log"
call pnpm stephy:auto >> "data\auto-runs.log" 2>&1
echo [%date% %time%] fin (exit %errorlevel%) >> "data\auto-runs.log"
echo. >> "data\auto-runs.log"
endlocal
