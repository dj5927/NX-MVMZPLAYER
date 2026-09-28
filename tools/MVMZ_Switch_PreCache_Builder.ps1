param([string]$GamePath)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms

$Script = Join-Path $PSScriptRoot 'build_switch_precache.py'
if (-not (Test-Path -LiteralPath $Script -PathType Leaf)) {
    [System.Windows.Forms.MessageBox]::Show("캐시 빌더를 찾을 수 없습니다.`r`n$Script", 'MVMZ Switch Pre-cache', 'OK', 'Error') | Out-Null
    exit 1
}

if (-not $GamePath) {
    $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
    $dialog.Description = 'RPG Maker MV/MZ 게임 폴더를 선택하세요. (root/game/www 모두 가능)'
    $dialog.ShowNewFolderButton = $false
    if ($dialog.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) { exit 0 }
    $GamePath = $dialog.SelectedPath
}

$choice = [System.Windows.Forms.MessageBox]::Show(
    "권장 모드: Smart 2GB raw RGBA 캐시를 만듭니다.`r`n맵 핵심 자산을 우선하고 남는 용량을 큰 일러스트부터 채웁니다.`r`n`r`n[예] Smart 2GB 권장`r`n[아니오] 모든 이미지 캐시(매우 큰 용량)`r`n[취소] 종료",
    'MVMZ Switch Pre-cache',
    [System.Windows.Forms.MessageBoxButtons]::YesNoCancel,
    [System.Windows.Forms.MessageBoxIcon]::Question
)
if ($choice -eq [System.Windows.Forms.DialogResult]::Cancel) { exit 0 }
$mode = if ($choice -eq [System.Windows.Forms.DialogResult]::No) { 'all' } else { 'smart' }

$python = (Get-Command python -ErrorAction SilentlyContinue).Source
if (-not $python) {
    [System.Windows.Forms.MessageBox]::Show('Python을 찾을 수 없습니다.', 'MVMZ Switch Pre-cache', 'OK', 'Error') | Out-Null
    exit 1
}

& $python $Script --game $GamePath --mode $mode --budget-mib 2048
if ($LASTEXITCODE -ne 0) {
    [System.Windows.Forms.MessageBox]::Show('Pre-cache 생성 중 오류가 발생했습니다. 콘솔 내용을 확인하세요.', 'MVMZ Switch Pre-cache', 'OK', 'Error') | Out-Null
    exit $LASTEXITCODE
}

[System.Windows.Forms.MessageBox]::Show(
    "완료되었습니다.`r`n게임 데이터 루트의 .mvmz_cache 폴더를 게임과 함께 Switch SD에 복사하세요.",
    'MVMZ Switch Pre-cache',
    'OK',
    'Information'
) | Out-Null
