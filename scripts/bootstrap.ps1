$ErrorActionPreference = "Stop"

function Test-Command($Name) {
  return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Refresh-Path {
  $machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  $extra = @(
    "$env:ProgramFiles\nodejs",
    "${env:ProgramFiles(x86)}\Git\cmd",
    "$env:ProgramFiles\Git\cmd",
    "$env:USERPROFILE\.local\bin"
  ) | Where-Object { $_ -and (Test-Path $_) }
  $env:Path = (@($userPath, $machinePath, $env:Path) + $extra) -join ";"
}

function Install-WingetPackage($Id, $Name) {
  if (-not (Test-Command winget)) {
    throw "Missing $Name and winget is not available. Install $Name manually, then rerun this script."
  }
  Write-Host "Installing $Name with winget..."
  winget install --id $Id -e --source winget --accept-package-agreements --accept-source-agreements
  Refresh-Path
}

Set-Location (Resolve-Path (Join-Path $PSScriptRoot ".."))
Refresh-Path

if (-not (Test-Command node) -or -not (Test-Command npm)) {
  Install-WingetPackage "OpenJS.NodeJS.LTS" "Node.js LTS"
}

if (-not (Test-Command git)) {
  Install-WingetPackage "Git.Git" "Git"
}

Refresh-Path

if (-not (Test-Command node) -or -not (Test-Command npm)) {
  throw "Node.js/npm are still not on PATH. Restart PowerShell and rerun scripts\bootstrap.ps1."
}

if (-not (Test-Command git)) {
  throw "Git is still not on PATH. Restart PowerShell and rerun scripts\bootstrap.ps1."
}

npm run setup:install
