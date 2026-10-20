param([switch]$Rebuild, [switch]$NoLaunch, [int]$DebugPort = 0)
$ErrorActionPreference = 'Stop'
$projectRoot = Join-Path $PSScriptRoot 'app'
Set-Location -LiteralPath $projectRoot

# Some corporate/proxy tooling (for example Steam++ / Clash Verge) intercepts HTTPS
# with its own certificate authority. Node and Bun reject those chains unless the CA
# is trusted explicitly, which breaks `bun install` postinstall downloads. Export any
# interception CAs already installed in the Windows certificate store so the launcher
# works without manual TLS tweaks.
$caBundlePath = Join-Path $PSScriptRoot 'proxy-ca-bundle.pem'
if (!$env:NODE_EXTRA_CA_CERTS -or !(Test-Path -LiteralPath $env:NODE_EXTRA_CA_CERTS)) {
    $interceptingCAs = @()
    foreach ($store in @('Cert:\CurrentUser\Root', 'Cert:\LocalMachine\Root')) {
        $interceptingCAs += @(Get-ChildItem -LiteralPath $store -ErrorAction SilentlyContinue |
            Where-Object { $_.Subject -match 'SteamTools|BeyondDimension|Clash|mihomo|verge' })
    }
    if ($interceptingCAs.Count -gt 0) {
        $pemParts = @()
        foreach ($ca in $interceptingCAs) {
            $b64 = [Convert]::ToBase64String($ca.RawData)
            $lines = [regex]::Matches($b64, '.{1,64}') | ForEach-Object { $_.Value }
            $pemParts += "-----BEGIN CERTIFICATE-----`r`n" + ($lines -join "`r`n") + "`r`n-----END CERTIFICATE-----"
        }
        [System.IO.File]::WriteAllText($caBundlePath, ($pemParts -join "`r`n") + "`r`n")
        $env:NODE_EXTRA_CA_CERTS = $caBundlePath
    }
}
if ($env:NODE_EXTRA_CA_CERTS) {
    $existingNodeOptions = ''
    if ($env:NODE_OPTIONS) { $existingNodeOptions = $env:NODE_OPTIONS }
    $env:NODE_OPTIONS = ($existingNodeOptions + ' --use-system-ca').Trim()
}

$bunCommand = Get-Command bun -ErrorAction SilentlyContinue
if ($bunCommand) {
    $bunPath = $bunCommand.Source
} else {
    $npmCache = (& npm config get cache).Trim()
    $npxRoot = Join-Path $npmCache '_npx'
    $candidates = @(Get-ChildItem -LiteralPath $npxRoot -Filter bun.exe -Recurse -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -match '[\\/]bun[\\/]bin[\\/]bun\.exe$' } |
        Sort-Object LastWriteTime -Descending)
    if ($candidates.Count -eq 0) {
        & npm exec --yes --package=bun -- bun --version
        if ($LASTEXITCODE -ne 0) { throw 'Bun installation failed.' }
        $candidates = @(Get-ChildItem -LiteralPath $npxRoot -Filter bun.exe -Recurse |
            Where-Object { $_.FullName -match '[\\/]bun[\\/]bin[\\/]bun\.exe$' } |
            Sort-Object LastWriteTime -Descending)
    }
    $bunPath = $candidates[0].FullName
}
$env:PATH = (Split-Path $bunPath) + ';' + $env:PATH
$env:CRAFT_CONFIG_DIR = Join-Path $PSScriptRoot '.visaflow-profile'
$env:VISAFLOW_DATA_DIR = Join-Path $PSScriptRoot 'data'
$env:CRAFT_APP_NAME = 'VisaFlow'
$env:CRAFT_DEV_RUNTIME = '1'
$env:CRAFT_DEBUG = 'true'
$env:CRAFT_BUN = $bunPath
foreach ($inheritedOption in @('ELECTRON_RUN_AS_NODE', 'VITE_DEV_SERVER_URL', 'CRAFT_SERVER_URL', 'CRAFT_HEADLESS')) {
    Remove-Item -LiteralPath ('Env:' + $inheritedOption) -ErrorAction SilentlyContinue
}

if (!(Test-Path -LiteralPath (Join-Path $projectRoot 'node_modules\electron\dist\electron.exe')) -or !(Test-Path -LiteralPath (Join-Path $projectRoot 'node_modules\@tesseract.js-data\eng\index.js'))) {
    if (!$env:ELECTRON_MIRROR) { $env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/' }
    & $bunPath install
    if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
}
if ($Rebuild -or !(Test-Path -LiteralPath (Join-Path $projectRoot 'apps\electron\dist\main.cjs')) -or !(Test-Path -LiteralPath (Join-Path $projectRoot 'apps\electron\dist\document-worker.cjs'))) {
    & $bunPath run visaflow:build
    if ($LASTEXITCODE -ne 0) { throw 'VisaFlow build failed.' }
}
if (!$NoLaunch) {
    $logDir = Join-Path $PSScriptRoot 'logs'
    New-Item -ItemType Directory -Path $logDir -Force | Out-Null
    $appArgument = '"' + (Join-Path $projectRoot 'apps\electron') + '"'
    $profileArgument = '--user-data-dir="' + (Join-Path $env:CRAFT_CONFIG_DIR 'electron') + '"'
    $desktopArguments = @($appArgument, $profileArgument)
    if ($DebugPort -gt 0) { $desktopArguments += '--remote-debugging-port=' + $DebugPort }
    Start-Process -FilePath (Join-Path $projectRoot 'node_modules\electron\dist\electron.exe') `
        -ArgumentList $desktopArguments -WorkingDirectory $projectRoot -WindowStyle Normal `
        -RedirectStandardOutput (Join-Path $logDir 'desktop-stdout.log') `
        -RedirectStandardError (Join-Path $logDir 'desktop-stderr.log') | Out-Null
}
