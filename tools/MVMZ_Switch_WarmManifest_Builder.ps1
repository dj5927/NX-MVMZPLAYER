param([string]$GamePath)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms

$Script = Join-Path $PSScriptRoot 'build_switch_warm_manifest.py'
if (-not (Test-Path -LiteralPath $Script -PathType Leaf)) {
    [System.Windows.Forms.MessageBox]::Show("Warm manifest builder not found.`r`n$Script", 'MVMZ Switch Warm Manifest', 'OK', 'Error') | Out-Null
    exit 1
}

if (-not $GamePath) {
    $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
    $dialog.Description = 'RPG Maker MV game folder (root/game/www)'
    $dialog.ShowNewFolderButton = $false
    if ($dialog.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) { exit 0 }
    $GamePath = $dialog.SelectedPath
}

$python = (Get-Command python -ErrorAction SilentlyContinue).Source
if (-not $python) {
    [System.Windows.Forms.MessageBox]::Show('Python not found.', 'MVMZ Switch Warm Manifest', 'OK', 'Error') | Out-Null
    exit 1
}

& $python $Script --game $GamePath
if ($LASTEXITCODE -ne 0) {
    [System.Windows.Forms.MessageBox]::Show('Warm manifest build failed. Check the console output.', 'MVMZ Switch Warm Manifest', 'OK', 'Error') | Out-Null
    exit $LASTEXITCODE
}

[System.Windows.Forms.MessageBox]::Show(
    "Done.`r`nCopy the generated .mvmz_warm folder with the game to the Switch SD card.",
    'MVMZ Switch Warm Manifest',
    'OK',
    'Information'
) | Out-Null
