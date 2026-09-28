@echo off
chcp 65001 > nul
cd /d "%~dp0"
title Sound Stitch Browser Mode
echo.
echo   Sound Stitch 브라우저 모드를 시작합니다.
echo   브라우저가 열리지 않으면 http://127.0.0.1:4173 로 접속하세요.
echo   종료하려면 이 창에서 Ctrl+C를 누르세요.
echo.
start "" "http://127.0.0.1:4173"
node server.js
pause
