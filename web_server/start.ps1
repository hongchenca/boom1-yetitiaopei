param(
  [int]$Port = 8000,
  [string]$HostAddress = "0.0.0.0",
  [string]$BasePath = "",
  [string]$DataDirectory = ""
)
$ErrorActionPreference = "Stop"
if (-not $DataDirectory) { $DataDirectory = Join-Path $PSScriptRoot "data" }
$env:APP_HOST = $HostAddress
$env:APP_PORT = "$Port"
$env:APP_BASE_PATH = $BasePath
$env:APP_DATA_DIR = $DataDirectory
Write-Host "Yetitiaopei web console: http://$HostAddress`:$Port$BasePath/"
Write-Host "首次运行后请查看 $DataDirectory\connection.json 获取本机登录密码。"
& node (Join-Path $PSScriptRoot "server.js")
