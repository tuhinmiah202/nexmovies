@echo off
echo =======================================================
echo         Updating Nexmovies to GitHub...
echo =======================================================
echo.
echo NOTE: If it asks for a password, please use your
echo GitHub Personal Access Token (PAT) instead of your password.
echo.
git config --global credential.helper manager
git add .
git commit -m "Integrated Backend, PWA and UI Fixes"
echo.
echo Attempting to push to main branch...
git push -f origin master:main
echo.
echo Attempting to push to master branch...
git push -f origin master:master
echo.
echo =======================================================
echo Push Process Finished. Please check your GitHub.
echo =======================================================
pause