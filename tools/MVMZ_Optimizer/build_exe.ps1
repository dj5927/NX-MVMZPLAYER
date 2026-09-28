$ErrorActionPreference = 'Stop'

$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = (Resolve-Path (Join-Path $Here '..\..')).Path
$OutDir = Join-Path $ProjectRoot 'TOOLS_DIST'
$WorkDir = Join-Path $Here '_pyinstaller_work'
$SpecDir = Join-Path $Here '_pyinstaller_spec'
$Entry = Join-Path $Here 'mvmz_optimizer.py'

$PyInstaller = (Get-Command pyinstaller -ErrorAction Stop).Source
New-Item -ItemType Directory -Force -Path $OutDir, $WorkDir, $SpecDir | Out-Null

& $PyInstaller `
    --noconfirm `
    --clean `
    --onefile `
    --windowed `
    --name MVMZ_Optimizer `
    --distpath $OutDir `
    --workpath $WorkDir `
    --specpath $SpecDir `
    $Entry

if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$Exe = Join-Path $OutDir 'MVMZ_Optimizer.exe'
if (-not (Test-Path -LiteralPath $Exe -PathType Leaf)) {
    throw "EXE was not created: $Exe"
}
$Hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $Exe).Hash
$Size = (Get-Item -LiteralPath $Exe).Length
Write-Output "EXE=$Exe"
Write-Output "SIZE=$Size"
Write-Output "SHA256=$Hash"

