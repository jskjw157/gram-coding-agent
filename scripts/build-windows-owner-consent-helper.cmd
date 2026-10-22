@echo off
setlocal EnableExtensions DisableDelayedExpansion

if "%~1"=="" exit /b 2
if not "%~2"=="" exit /b 2

set "HELPER_OUTPUT=%~f1"
set "HELPER_SOURCE=%~dp0..\apps\windows-owner-consent-helper\main.cpp"
set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"

if not exist "%VSWHERE%" exit /b 1

set "VS_INSTALL="
for /f "usebackq delims=" %%I in (`"%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set "VS_INSTALL=%%I"

if not defined VS_INSTALL exit /b 1
if not exist "%VS_INSTALL%\VC\Auxiliary\Build\vcvars64.bat" exit /b 1

call "%VS_INSTALL%\VC\Auxiliary\Build\vcvars64.bat" >nul
if errorlevel 1 exit /b 1

cl.exe /nologo /std:c++20 /W4 /WX /EHsc /MT /guard:cf /utf-8 /DUNICODE /D_UNICODE /Fo"%HELPER_OUTPUT%.obj" /Fe"%HELPER_OUTPUT%" "%HELPER_SOURCE%" /link /MACHINE:X64 /SUBSYSTEM:CONSOLE /DYNAMICBASE /NXCOMPAT /GUARD:CF /DEPENDENTLOADFLAG:0x800 windowsapp.lib advapi32.lib user32.lib gdi32.lib
exit /b %errorlevel%
