@echo off
setlocal
title Coders' Cafe - RESTORA website
rem Double-click to start the Coders' Cafe customer website on this PC.
rem Works from inside the food folder, or from anywhere if the project is at Downloads\food.
set "APP=%~dp0"
if not exist "%APP%package.json" set "APP=%USERPROFILE%\Downloads\food\"
if not exist "%APP%package.json" (
  echo Could not find the RESTORA project. Put this file inside the food folder and run it again.
  pause
  exit /b 1
)
cd /d "%APP%"
echo.
echo === 1/2  Loading the Coders' Cafe menu into the dev database - skipped if already there ===
call npm run db:seed:cafe
echo.
echo === 2/2  Starting the website - keep this window open while you use it ===
echo.
echo   Customer, Table 07 :  http://localhost:3000/t/ccZivJX3UARCmdym9KSjygqB
echo   Staff sign-in      :  http://localhost:3000/login   cafe.manager@demo.local / Demo@12345
echo   If the server says a different port than 3000, use that port in the links.
echo.
start "" /min cmd /c "timeout /t 20 /nobreak >nul & start http://localhost:3000/t/ccZivJX3UARCmdym9KSjygqB"
call npm run dev
pause
