@echo off
set PATH=C:\Program Files\Git\cmd;C:\Program Files\Git\bin;%PATH%
cd /d "%~dp0"
git add .
git commit -m "Add password login, persist full chat history"
git push
echo.
echo Live at: https://abhiravgotra92.github.io/livechat/
echo.
pause
