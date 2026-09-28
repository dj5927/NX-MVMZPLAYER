param()
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Url = "https://raw.githubusercontent.com/notofonts/noto-cjk/main/Sans/OTF/Korean/NotoSansCJKkr-Regular.otf"
$Expected = "6BCB2A0703AA137E874FC2DFFA85F6C21BA9A67FA329E81B8C801663AF7E992A"
$Temp = Join-Path ([System.IO.Path]::GetTempPath()) "NotoSansCJKkr-Regular.otf"
Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $Temp
$Hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $Temp).Hash
if ($Hash -ne $Expected) { throw "Noto CJK SHA-256 mismatch: $Hash" }
$Targets = @(
  "source/SWITCH_HOS/UNIVERSAL_PLAYER/romfs/fonts/NotoSansCJKkr-Regular.otf",
  "source/SWITCH_HOS/SPLIT_RUNTIME/LAUNCHER/romfs/fonts/NotoSansCJKkr-Regular.otf",
  "source/SWITCH_HOS/SPLIT_RUNTIME/MV_PLAYER/romfs/fonts/NotoSansCJKkr-Regular.otf",
  "source/SWITCH_HOS/SPLIT_RUNTIME/MZ_PLAYER/romfs/fonts/NotoSansCJKkr-Regular.otf"
)
foreach ($Rel in $Targets) {
  $Dst = Join-Path $Root $Rel
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Dst) | Out-Null
  Copy-Item -LiteralPath $Temp -Destination $Dst -Force
}
Remove-Item -LiteralPath $Temp -Force
Write-Host "NotoSansCJKkr-Regular.otf ready ($Expected)"