#Requires -Version 5.1
[CmdletBinding()]
param(
    [string]$OutputDirectory
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path

function Get-TreeHashes {
    param([string]$Root)

    $base = (Resolve-Path -LiteralPath $Root).Path.TrimEnd('\', '/')
    $prefix = $base + [IO.Path]::DirectorySeparatorChar
    $entries = foreach ($file in Get-ChildItem -LiteralPath $base -File -Recurse) {
        $relative = $file.FullName.Substring($prefix.Length).Replace('\', '/')
        if ($relative -match '^dev/(runs|\.runner)(/|$)') { continue }
        $hash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash
        "$relative`t$hash"
    }
    @($entries | Sort-Object)
}

function Copy-WhitelistedFiles {
    param(
        [string]$SourceRoot,
        [string]$DestinationRoot,
        [string[]]$Files
    )

    foreach ($relative in $Files) {
        $source = Join-Path $SourceRoot $relative
        if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
            throw "Required release file is missing: $source"
        }
        $destination = Join-Path $DestinationRoot $relative
        [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($destination)) | Out-Null
        Copy-Item -LiteralPath $source -Destination $destination
    }
}

function Add-ProjectLicense {
    param([string]$DestinationRoot)

    Copy-WhitelistedFiles -SourceRoot $repoRoot -DestinationRoot $DestinationRoot -Files @('LICENSE')
}

$canonical = Join-Path $repoRoot 'dsh\connector'
$bundled = Join-Path $repoRoot 'dsh\plugin\connector'
$sourceHashes = Get-TreeHashes -Root $canonical
$bundleHashes = Get-TreeHashes -Root $bundled
$sourceDiff = @(Compare-Object -ReferenceObject $sourceHashes -DifferenceObject $bundleHashes)
if ($sourceDiff.Count -gt 0) {
    $paths = $sourceDiff | ForEach-Object { $_.InputObject.Split("`t")[0] } | Sort-Object -Unique
    throw "The DSH plugin connector snapshot is stale. Sync dsh/plugin/connector from dsh/connector first. Differences: $($paths -join ', ')"
}

$node = (Get-Command node -ErrorAction Stop).Source
Push-Location $repoRoot
try {
    & $node --check 'dsh/plugin/index.js'
    if ($LASTEXITCODE -ne 0) { throw 'DSH plugin index.js syntax check failed.' }
    & $node --check 'dsh/plugin/client.js'
    if ($LASTEXITCODE -ne 0) { throw 'DSH plugin client.js syntax check failed.' }
    & $node --test 'dsh/plugin/index.test.js'
    if ($LASTEXITCODE -ne 0) { throw 'DSH plugin tests failed.' }
} finally {
    Pop-Location
}

if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
    $parent = Split-Path -Parent $repoRoot
    $outputBase = Join-Path $parent '交付\gety-client-connectors'
} elseif ([IO.Path]::IsPathRooted($OutputDirectory)) {
    $outputBase = [IO.Path]::GetFullPath($OutputDirectory)
} else {
    $outputBase = [IO.Path]::GetFullPath((Join-Path $repoRoot $OutputDirectory))
}

$repoPrefix = $repoRoot.TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
if ($outputBase.Equals($repoRoot, [StringComparison]::OrdinalIgnoreCase) -or
    $outputBase.StartsWith($repoPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Choose an output directory outside the tracked repository.'
}

$releaseName = 'release-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 8)
$releaseDirectory = Join-Path $outputBase $releaseName
$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\', '/')
$stageRoot = Join-Path $tempRoot ('gety-client-connectors-' + [Guid]::NewGuid().ToString('N'))
$stageFullPath = [IO.Path]::GetFullPath($stageRoot)
$tempPrefix = $tempRoot + [IO.Path]::DirectorySeparatorChar
if (-not $stageFullPath.StartsWith($tempPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Temporary staging path escaped the system temporary directory.'
}

[IO.Directory]::CreateDirectory($stageRoot) | Out-Null
try {
    $dshFiles = @('manifest.json', 'dist/main.js', 'assets/dsh.svg', 'src/vendor/fzstd.LICENSE')
    $workbuddyFiles = @('manifest.json', 'dist/main.js', 'assets/workbuddy.svg')
    $pluginFiles = @('index.js', 'client.js', 'package.json', 'cordis.patch.yml', 'icon.svg')
    $pluginFiles += Get-ChildItem -LiteralPath (Join-Path $repoRoot 'dsh\plugin\locale') -File -Filter '*.json' |
        ForEach-Object { 'locale/' + $_.Name }
    if (-not ($pluginFiles | Where-Object { $_ -like 'locale/*.json' })) {
        throw 'No DSH plugin locale files were found.'
    }

    $dshStage = Join-Path $stageRoot 'dsh-connector'
    Copy-WhitelistedFiles -SourceRoot $canonical -DestinationRoot $dshStage -Files $dshFiles
    Add-ProjectLicense -DestinationRoot $dshStage

    $pluginStage = Join-Path $stageRoot 'dsh-plugin'
    Copy-WhitelistedFiles -SourceRoot (Join-Path $repoRoot 'dsh\plugin') -DestinationRoot $pluginStage -Files $pluginFiles
    Add-ProjectLicense -DestinationRoot $pluginStage
    $pluginConnectorStage = Join-Path $pluginStage 'connector'
    Copy-WhitelistedFiles -SourceRoot $canonical -DestinationRoot $pluginConnectorStage -Files $dshFiles
    Add-ProjectLicense -DestinationRoot $pluginConnectorStage

    $workbuddyStage = Join-Path $stageRoot 'workbuddy-connector'
    Copy-WhitelistedFiles -SourceRoot (Join-Path $repoRoot 'workbuddy\connector') -DestinationRoot $workbuddyStage -Files $workbuddyFiles
    Add-ProjectLicense -DestinationRoot $workbuddyStage

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    foreach ($name in @('dsh-connector', 'dsh-plugin', 'workbuddy-connector')) {
        $packageRoot = Join-Path $stageRoot $name
        $packagePrefix = $packageRoot.TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
        $archive = [IO.Compression.ZipFile]::Open((Join-Path $stageRoot ($name + '.zip')), 'Create')
        try {
            foreach ($file in Get-ChildItem -LiteralPath $packageRoot -File -Recurse) {
                $entryName = $file.FullName.Substring($packagePrefix.Length).Replace('\', '/')
                [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $file.FullName, $entryName, 'Optimal') | Out-Null
            }
        } finally {
            $archive.Dispose()
        }
    }

    $sums = Get-ChildItem -LiteralPath $stageRoot -File -Filter '*.zip' |
        Sort-Object Name |
        ForEach-Object { "$(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256 | ForEach-Object Hash)  $($_.Name)" }
    [IO.File]::WriteAllLines((Join-Path $stageRoot 'SHA256SUMS.txt'), $sums, [Text.Encoding]::ASCII)

    [IO.Directory]::CreateDirectory($outputBase) | Out-Null
    if (Test-Path -LiteralPath $releaseDirectory) {
        throw "Release output already exists: $releaseDirectory"
    }
    [IO.Directory]::CreateDirectory($releaseDirectory) | Out-Null
    Get-ChildItem -LiteralPath $stageRoot -File | Copy-Item -Destination $releaseDirectory
    Write-Host "Release archives prepared in: $releaseDirectory"
} finally {
    if (Test-Path -LiteralPath $stageFullPath) {
        Remove-Item -LiteralPath $stageFullPath -Recurse -Force
    }
}
