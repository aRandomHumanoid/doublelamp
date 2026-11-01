<#
DoubleLamp firmware helper (docs/09-bring-up.md).

Run ESP-IDF's environment script in the same PowerShell window first:
    . $HOME\esp\esp-idf-v5.5.6\export.ps1

Then, from this folder:
    .\lamp.ps1 build                 # development build (accepts a ws:// server on your LAN)
    .\lamp.ps1 flash -Port COM5      # build, flash and open the serial monitor
    .\lamp.ps1 monitor -Port COM5    # serial monitor only (Ctrl+] to quit)
    .\lamp.ps1 erase -Port COM5      # wipe the whole flash: WiFi, settings, Apple Home pairings
    .\lamp.ps1 build -Release        # release build: https/wss servers only (for Cloudflare later)
    .\lamp.ps1 size                  # flash/RAM budget check

Dev and release builds live in separate folders (build-dev, build-release) with their own sdkconfig.
After editing sdkconfig.defaults or sdkconfig.dev, run `.\lamp.ps1 fullclean` so the change applies.
#>
param(
    [Parameter(Position = 0)]
    [ValidateSet('build', 'flash', 'monitor', 'erase', 'size', 'menuconfig', 'fullclean')]
    [string]$Command = 'build',
    [string]$Port,
    [switch]$Release
)

$ErrorActionPreference = 'Stop'
if (-not $env:IDF_PATH) {
    throw 'ESP-IDF is not set up in this window. Run:  . $HOME\esp\esp-idf-v5.5.6\export.ps1'
}
Set-Location $PSScriptRoot

$key = Join-Path $PSScriptRoot 'keys\signing_key.pem'
if ($Command -in @('build', 'flash', 'size') -and -not (Test-Path $key)) {
    throw "No firmware signing key at keys\signing_key.pem. Create it once (docs/09-bring-up.md, step 2):`n  espsecure.py generate_signing_key --version 2 --scheme rsa3072 keys\signing_key.pem"
}

$kind = if ($Release) { 'release' } else { 'dev' }
$buildDir = "build-$kind"
$defaults = if ($Release) { 'sdkconfig.defaults' } else { 'sdkconfig.defaults;sdkconfig.dev' }
$idfArgs = @('-B', $buildDir, '-D', "SDKCONFIG=$buildDir/sdkconfig", '-D', "SDKCONFIG_DEFAULTS=$defaults")
if ($Port) { $idfArgs += @('-p', $Port) }

if (-not (Test-Path 'third_party\esp-homekit-sdk\components\homekit')) {
    Write-Warning 'esp-homekit-sdk is not checked out: this build has no Apple Home (docs/09-bring-up.md, step 2).'
}

switch ($Command) {
    'build'      { idf.py @idfArgs build }
    'flash'      { if (-not $Port) { throw 'Give the serial port, e.g. -Port COM5 (Device Manager > Ports)' }; idf.py @idfArgs build flash monitor }
    'monitor'    { if (-not $Port) { throw 'Give the serial port, e.g. -Port COM5' }; idf.py @idfArgs monitor }
    'erase'      { if (-not $Port) { throw 'Give the serial port, e.g. -Port COM5' }; idf.py @idfArgs erase-flash }
    'size'       { idf.py @idfArgs size }
    'menuconfig' { idf.py @idfArgs menuconfig }
    'fullclean'  { idf.py @idfArgs fullclean; if (Test-Path "$buildDir\sdkconfig") { Remove-Item "$buildDir\sdkconfig" } }
}
exit $LASTEXITCODE
