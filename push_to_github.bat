@echo off
echo Updating Nexmovies to GitHub...
git add .
git commit -m "Integrated Backend, PWA and Mobile UI Fixes"
git push -f origin master:main
git push -f origin master:master
echo.
echo ========================================
echo Push Complete! Please check your GitHub.
echo ========================================
pause