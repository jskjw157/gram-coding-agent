@echo off
setlocal
if "%~1"=="" exit /b 2
set "GRAM_WORKSPACE_OUTPUT=%~f1"
for /f "usebackq tokens=*" %%I in (`"%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set "GRAM_WORKSPACE_VS=%%I"
if not defined GRAM_WORKSPACE_VS exit /b 3
call "%GRAM_WORKSPACE_VS%\VC\Auxiliary\Build\vcvars64.bat" >nul
if errorlevel 1 exit /b 4
cl /nologo /std:c++20 /EHsc /W4 /WX /MT /guard:cf "%~dp0..\apps\windows-workspace-helper\main.cpp" /Fo:"%GRAM_WORKSPACE_OUTPUT%.obj" /Fe:"%GRAM_WORKSPACE_OUTPUT%" /link /DYNAMICBASE /NXCOMPAT /DEPENDENTLOADFLAG:0x800
