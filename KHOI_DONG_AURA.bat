@echo off
title AURA DESKTOP ASSISTANT - ELECTRON LAUNCHER
color 0b

REM Xoa bien moi truong ELECTRON_RUN_AS_NODE (neu chay tu VS Code terminal)
set ELECTRON_RUN_AS_NODE=

cd /d "%~dp0"

set ELECTRON_EXE=node_modules\electron\dist\electron.exe
set PYTHON_EXE=runtime\python\python.exe

REM Neu da co day du Electron va Python, khoi chay sieu toc (trong 0.1 giay)
if exist "%ELECTRON_EXE%" if exist "%PYTHON_EXE%" if exist "assets\models\aura.vrm" (
    echo [OK] He thong da san sang. Dang khoi chay AURA ngay lap tuc...
    start "" "%ELECTRON_EXE%" .
    exit /b 0
)

REM Truong hop khoi dong lan dau hoac thieu file, tien hanh kiem tra day du
echo ================================================================================
echo             AURA DESKTOP ASSISTANT - KIEM TRA MOI TRUONG LAN DAU
echo ================================================================================
echo.

echo [1/4] Kiem tra Node.js Runtime...
where node >nul 2>nul
if %errorlevel% neq 0 (
    color 0c
    echo [LOI] Khong tim thay Node.js tren may! Vui long cai dat Node.js.
    pause
    exit /b 1
)

echo [2/4] Kiem tra Electron...
if not exist "%ELECTRON_EXE%" (
    echo       -> Dang cai dat Electron...
    call npm.cmd install
    node "node_modules\electron\install.js"
)

echo [3/4] Kiem tra Python Portable va cac thu vien...
if not exist "%PYTHON_EXE%" (
    color 0c
    echo [LOI] Khong tim thay Python Portable tai runtime\python\python.exe!
    pause
    exit /b 1
)

"%PYTHON_EXE%" -c "import edge_tts" >nul 2>nul
if %errorlevel% neq 0 (
    echo       -> Dang cai dat edge-tts...
    "%PYTHON_EXE%" -m pip install edge-tts
)
"%PYTHON_EXE%" -c "import faster_whisper" >nul 2>nul
if %errorlevel% neq 0 (
    echo       -> Dang cai dat faster-whisper...
    "%PYTHON_EXE%" -m pip install faster-whisper
)

echo [4/4] Kiem tra mo hinh nhan vat 3D...
if not exist "assets\models\aura.vrm" (
    color 0e
    echo [CANH BAO] Chua tim thay file assets\models\aura.vrm!
)

echo.
echo [HOAN TAT] Dang mo cua so AURA tren man hinh...
start "" "%ELECTRON_EXE%" .
exit /b 0
