param([switch]$ReplayOnly)
$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'Start-VisaFlow.ps1') -NoLaunch
if (!$ReplayOnly) {
    & $env:CRAFT_BUN test packages/visaflow-core packages/shared/src/protocol/__tests__/routing.test.ts
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
& $env:CRAFT_BUN packages/visaflow-core/src/cli.ts replay --data-dir (Join-Path $PSScriptRoot 'verification\core-replay')
exit $LASTEXITCODE
