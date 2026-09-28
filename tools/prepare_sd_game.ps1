param(
    [Parameter(Mandatory=$true)]
    [string]$Source,

    [Parameter(Mandatory=$true)]
    [string]$Output
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Normalize-FullPath([string]$Path) {
    return [System.IO.Path]::GetFullPath($Path).TrimEnd('\','/')
}

function Get-RelativePathCompat([string]$Base, [string]$Full) {
    $baseUri = New-Object System.Uri(($Base.TrimEnd('\') + '\'))
    $fullUri = New-Object System.Uri($Full)
    return [System.Uri]::UnescapeDataString($baseUri.MakeRelativeUri($fullUri).ToString()).Replace('/','\')
}

function Get-Hash16([string]$Text) {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($Text)
        $hash = $sha.ComputeHash($bytes)
        return ([System.BitConverter]::ToString($hash).Replace('-','').ToLowerInvariant()).Substring(0,16)
    }
    finally {
        $sha.Dispose()
    }
}

function Is-AsciiSegment([string]$Segment) {
    if ([string]::IsNullOrEmpty($Segment)) { return $true }
    foreach ($ch in $Segment.ToCharArray()) {
        if ([int][char]$ch -gt 0x7f) { return $false }
    }
    return $true
}

function Get-SafeSegment([string]$Segment, [bool]$IsFile) {
    if (Is-AsciiSegment $Segment) { return $Segment }
    $hash = Get-Hash16 $Segment
    if ($IsFile) {
        $ext = [System.IO.Path]::GetExtension($Segment)
        if ($ext -and (Is-AsciiSegment $ext) -and $ext.Length -le 16) {
            return "__mvmz_u_${hash}${ext}"
        }
    }
    return "__mvmz_u_${hash}"
}

function Convert-RelativeToSafe([string]$Relative, [bool]$LeafIsFile) {
    $parts = @($Relative.Replace('/','\').Split([char]'\') | Where-Object { $_ -ne '' })
    $safe = New-Object System.Collections.Generic.List[string]
    for ($i = 0; $i -lt $parts.Count; $i++) {
        $safe.Add((Get-SafeSegment $parts[$i] ($LeafIsFile -and $i -eq $parts.Count - 1)))
    }
    return ($safe -join '\')
}

$src = Normalize-FullPath $Source
$dst = Normalize-FullPath $Output

if (-not (Test-Path -LiteralPath $src -PathType Container)) {
    throw "Source folder not found: $src"
}

if (Test-Path -LiteralPath $dst) {
    $existing = @(Get-ChildItem -LiteralPath $dst -Force -ErrorAction SilentlyContinue)
    if ($existing.Count -gt 0) {
        throw "Output folder must be empty/new. Existing files are not deleted automatically: $dst"
    }
} else {
    New-Item -ItemType Directory -Path $dst -Force | Out-Null
}

$dataRootRel = $null
foreach ($candidate in @('game','www','')) {
    $base = if ($candidate) { Join-Path $src $candidate } else { $src }
    if (-not (Test-Path -LiteralPath (Join-Path $base 'index.html') -PathType Leaf)) { continue }
    $isMv = Test-Path -LiteralPath (Join-Path $base 'js\rpg_core.js') -PathType Leaf
    $isMz = Test-Path -LiteralPath (Join-Path $base 'js\rmmz_core.js') -PathType Leaf
    if ($isMv -or $isMz) {
        $dataRootRel = $candidate
        break
    }
}

if ($null -eq $dataRootRel) {
    throw "Could not detect RPG Maker MV/MZ data root (index.html + rpg_core.js/rmmz_core.js)."
}

$safeDataRootRel = if ($dataRootRel) { Convert-RelativeToSafe $dataRootRel $false } else { '' }
$manifestPaths = [ordered]@{}
$renamedFiles = 0
$renamedDirs = 0
$copiedFiles = 0
$copiedBytes = [int64]0

$directories = @(Get-ChildItem -LiteralPath $src -Recurse -Directory -Force)
foreach ($dir in $directories) {
    $rel = Get-RelativePathCompat $src $dir.FullName
    $safeRel = Convert-RelativeToSafe $rel $false
    if ($rel -ne $safeRel) { $renamedDirs++ }
    New-Item -ItemType Directory -Path (Join-Path $dst $safeRel) -Force | Out-Null
}

$files = @(Get-ChildItem -LiteralPath $src -Recurse -File -Force)
foreach ($file in $files) {
    $rel = Get-RelativePathCompat $src $file.FullName
    $safeRel = Convert-RelativeToSafe $rel $true
    $target = Join-Path $dst $safeRel
    $parent = Split-Path -Parent $target
    if (-not (Test-Path -LiteralPath $parent)) {
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
    }
    Copy-Item -LiteralPath $file.FullName -Destination $target -Force
    $copiedFiles++
    $copiedBytes += [int64]$file.Length
    if ($rel -ne $safeRel) { $renamedFiles++ }

    $insideData = $false
    $originalInside = ''
    $safeInside = ''
    if ([string]::IsNullOrEmpty($dataRootRel)) {
        $insideData = $true
        $originalInside = $rel
        $safeInside = $safeRel
    } elseif ($rel.StartsWith($dataRootRel + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
        $insideData = $true
        $originalInside = $rel.Substring($dataRootRel.Length + 1)
        if ($safeRel.StartsWith($safeDataRootRel + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
            $safeInside = $safeRel.Substring($safeDataRootRel.Length + 1)
        }
    }

    if ($insideData -and $originalInside -and $safeInside -and $originalInside -ne $safeInside) {
        $originalKey = $originalInside.Replace('\','/')
        $safeValue = $safeInside.Replace('\','/')
        $manifestPaths[$originalKey] = $safeValue
        try { $manifestPaths[$originalKey.Normalize([Text.NormalizationForm]::FormC)] = $safeValue } catch {}
        try { $manifestPaths[$originalKey.Normalize([Text.NormalizationForm]::FormKC)] = $safeValue } catch {}
    }
}

$manifestRoot = if ($safeDataRootRel) { Join-Path $dst $safeDataRootRel } else { $dst }
$manifestPath = Join-Path $manifestRoot '.mvmz_paths.json'
$manifest = [ordered]@{
    version = 1
    generatedBy = 'MVMZ prepare_sd_game.ps1'
    sourceDataRoot = if ($dataRootRel) { $dataRootRel.Replace('\','/') } else { '.' }
    paths = $manifestPaths
}
$json = $manifest | ConvertTo-Json -Depth 8
[System.IO.File]::WriteAllText($manifestPath, $json, (New-Object System.Text.UTF8Encoding($false)))

$unsafeOutput = @(Get-ChildItem -LiteralPath $dst -Recurse -Force | Where-Object {
    $rel = Get-RelativePathCompat $dst $_.FullName
    -not (Is-AsciiSegment $rel)
})

Write-Host ""
Write-Host "MVMZ SD-safe package complete"
Write-Host "Source          : $src"
Write-Host "Output          : $dst"
Write-Host "Data root       : $(if ($dataRootRel) { $dataRootRel } else { '.' })"
Write-Host "Files copied    : $copiedFiles"
Write-Host "Bytes copied    : $copiedBytes"
Write-Host "Renamed files   : $renamedFiles"
Write-Host "Renamed dirs    : $renamedDirs"
Write-Host "Manifest entries: $($manifestPaths.Count)"
Write-Host "Manifest        : $manifestPath"
Write-Host "Non-ASCII output paths remaining: $($unsafeOutput.Count)"

if ($unsafeOutput.Count -gt 0) {
    Write-Warning "Some output path segments are still non-ASCII. Do not copy this package to SD until reviewed."
    $unsafeOutput | Select-Object -First 30 -ExpandProperty FullName | ForEach-Object { Write-Warning $_ }
    exit 2
}

Write-Host "OK: copy the OUTPUT folder under sdmc:/mvmz/<ASCII_GAME_FOLDER>/"
