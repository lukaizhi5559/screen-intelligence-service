@echo off
REM Build script for Windows OCR binary
REM Requires .NET 6.0 SDK or later
REM
REM Usage: build.bat

echo Building Windows OCR binary...
echo.

REM Check if .NET SDK is installed
dotnet --version >nul 2>&1
if %errorlevel% neq 0 (
    echo ERROR: .NET SDK not found!
    echo Please install .NET 6.0 SDK or later from:
    echo https://dotnet.microsoft.com/download
    exit /b 1
)

REM Build the project
echo Building for Windows x64...
dotnet publish -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -p:PublishTrimmed=false

if %errorlevel% neq 0 (
    echo.
    echo ERROR: Build failed!
    exit /b 1
)

REM Copy binary to parent bin directory
echo.
echo Copying binary to bin directory...
copy /Y bin\Release\net6.0-windows10.0.19041.0\win-x64\publish\WindowsOCR.exe ..\windows-ocr.exe

if %errorlevel% neq 0 (
    echo.
    echo ERROR: Failed to copy binary!
    exit /b 1
)

echo.
echo ✓ Build successful!
echo Binary location: ..\windows-ocr.exe
echo.
echo You can now use: windows-ocr.exe "path\to\image.png"
