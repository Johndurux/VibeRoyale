@echo off
title VibeRoyale Server
cd /d "%~dp0royale"
echo ============================================
echo   VibeRoyale - server lokal
echo   Buka di browser: http://localhost:8123
echo   Biarkan jendela ini terbuka saat main.
echo   Tutup jendela ini untuk mematikan server.
echo ============================================
:loop
node serve.mjs
echo Server berhenti, restart dalam 2 detik...
timeout /t 2 >nul
goto loop
