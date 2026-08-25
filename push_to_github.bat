@echo off
echo =======================================================
echo         Updating Nexmovies to GitHub...
echo =======================================================
echo.
echo 1. Adding latest changes...
git add .
echo 2. Saving changes (Commit)...
git commit -m "Updated backend proxy, headers, and UI fixes"
echo.
echo 3. Sending to GitHub (Force Push)...
echo Attempting to update main branch...
git push -f origin HEAD:main
echo.
echo Attempting to update master branch...
git push -f origin HEAD:master
echo.
echo =======================================================
echo If you see 'Everything up-to-date', it means no new
echo changes were found or the push was already successful.
echo =======================================================
pause