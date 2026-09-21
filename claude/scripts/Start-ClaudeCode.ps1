<#
.SYNOPSIS
    계정(CLAUDE_CONFIG_DIR)별로 분리된 Claude Code 환경에서 VS Code 또는 claude CLI를 실행한다.

.DESCRIPTION
    Claude Code VS Code 확장은 "VS Code를 띄운 프로세스의 환경변수"를 물려받는다.
    따라서 CLAUDE_CONFIG_DIR를 설정한 뒤 code 를 실행하면 창 단위로 계정이 갈린다.

    주의: VS Code가 이미 떠 있으면 새 `code .` 호출은 기존 메인 프로세스에 창만 추가하므로
    "예전 환경변수"를 그대로 물려받는다. 이 스크립트는 기본적으로 계정별
    --user-data-dir 를 지정해 별도 프로세스를 강제하므로 이 문제를 피한다.
    (확장 목록은 --extensions-dir 기본값을 공유하므로 다시 설치할 필요 없다.)

.PARAMETER Account
    계정 별칭. 예: work, personal.
    CLAUDE_CONFIG_DIR = $env:USERPROFILE\.claude-<Account>
    생략하면 account-map.json 에서 대상 경로로 자동 판별한다.

.PARAMETER Path
    열 저장소 경로. 기본값은 현재 디렉터리.

.PARAMETER Login
    VS Code 대신 claude CLI 를 해당 계정 환경으로 실행한다. 최초 /login 용.

.PARAMETER Shared
    --user-data-dir 분리를 끄고 기본 VS Code 프로필을 그대로 쓴다.
    (VS Code가 이미 실행 중이면 계정 분리가 깨질 수 있음)

.PARAMETER List
    등록된 계정 디렉터리와 로그인 여부를 출력한다.

.EXAMPLE
    .\Start-ClaudeCode.ps1 -Account work -Login
    .\Start-ClaudeCode.ps1 -Account work  C:\repos\work-repo
    .\Start-ClaudeCode.ps1 -List
#>
[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string]$Account,

    [Parameter(Position = 1)]
    [string]$Path = '.',

    [switch]$Login,
    [switch]$Shared,
    [switch]$List
)

$ErrorActionPreference = 'Stop'

$HomeDir = $env:USERPROFILE
$MapFile = Join-Path $PSScriptRoot 'account-map.json'

function Get-ConfigDir([string]$Name) {
    return (Join-Path $HomeDir ".claude-$Name")
}

function Get-UserDataDir([string]$Name) {
    return (Join-Path $env:LOCALAPPDATA "vscode-claude-$Name")
}

function Get-KnownAccounts {
    $dirs = Get-ChildItem -Path $HomeDir -Directory -Filter '.claude-*' -Force -ErrorAction SilentlyContinue
    $result = @()
    foreach ($d in $dirs) {
        $result += [pscustomobject]@{
            Account   = $d.Name.Substring('.claude-'.Length)
            ConfigDir = $d.FullName
            LoggedIn  = Test-Path (Join-Path $d.FullName '.credentials.json')
        }
    }
    return $result
}

function Resolve-ClaudeExe {
    $cmd = Get-Command claude -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }

    # PATH에 없으면 VS Code 확장에 번들된 바이너리를 사용한다 (버전 최신 순).
    $pattern = Join-Path $HomeDir '.vscode\extensions\anthropic.claude-code-*\resources\native-binary\claude.exe'
    $bundled = Get-ChildItem -Path $pattern -ErrorAction SilentlyContinue |
               Sort-Object LastWriteTime -Descending |
               Select-Object -First 1
    if ($bundled) { return $bundled.FullName }

    return $null
}

function Resolve-CodeExe {
    $cmd = Get-Command code.cmd -ErrorAction SilentlyContinue
    if (-not $cmd) { $cmd = Get-Command code -ErrorAction SilentlyContinue }
    if ($cmd) { return $cmd.Source }

    $fallback = Join-Path $env:LOCALAPPDATA 'Programs\Microsoft VS Code\bin\code.cmd'
    if (Test-Path $fallback) { return $fallback }

    return $null
}

function Resolve-AccountFromMap([string]$TargetPath) {
    if (-not (Test-Path $MapFile)) { return $null }

    $raw = Get-Content -Path $MapFile -Raw -Encoding UTF8
    if ([string]::IsNullOrWhiteSpace($raw)) { return $null }

    # Windows 경로를 JSON에 쓸 때 "C:\Users" 처럼 역슬래시를 하나만 쓰는 경우가 흔하다.
    # 이미 이중인 것(\\)은 그대로 두고 홑 역슬래시만 이중으로 바꾼다.
    # 이 파일은 경로 전용이므로 \r, \t 같은 제어문자 이스케이프는 해석하지 않는다.
    # (그래야 "C:\repos" 의 \r 가 캐리지리턴으로 잘못 해석되지 않는다.)
    $normalized = [regex]::Replace($raw, '\\\\|\\', {
        param($m)
        if ($m.Value.Length -eq 2) { return $m.Value }
        return '\\'
    })

    try {
        $map = $normalized | ConvertFrom-Json
    }
    catch {
        Write-Warning "매핑 파일을 읽지 못했습니다: $MapFile`n$($_.Exception.Message)"
        return $null
    }

    $target = $TargetPath.Replace('/', '\')
    $best = $null
    $bestLen = -1

    foreach ($entry in $map.PSObject.Properties) {
        $prefix = $entry.Name.Replace('/', '\').TrimEnd('\')
        if ($target.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
            if ($prefix.Length -gt $bestLen) {
                $bestLen = $prefix.Length
                $best = $entry.Value
            }
        }
    }
    return $best
}

function Initialize-UserDataDir([string]$Dir) {
    if (Test-Path $Dir) { return }

    New-Item -ItemType Directory -Path $Dir -Force | Out-Null
    $userDir = Join-Path $Dir 'User'
    New-Item -ItemType Directory -Path $userDir -Force | Out-Null

    # 기본 프로필의 설정을 한 번만 복사해 초기 상태를 맞춘다.
    $srcUser = Join-Path $env:APPDATA 'Code\User'
    foreach ($item in @('settings.json', 'keybindings.json', 'snippets')) {
        $src = Join-Path $srcUser $item
        if (Test-Path $src) {
            Copy-Item -Path $src -Destination $userDir -Recurse -Force
        }
    }
    Write-Host "  [seed] 기본 VS Code 설정을 새 프로필로 복사했습니다: $Dir" -ForegroundColor DarkGray
}

# ---------------------------------------------------------------- -List

if ($List) {
    $accounts = Get-KnownAccounts
    if (-not $accounts -or $accounts.Count -eq 0) {
        Write-Host "등록된 계정이 없습니다. 먼저 로그인하세요:" -ForegroundColor Yellow
        Write-Host "  .\Start-ClaudeCode.ps1 -Account work -Login"
        return
    }

    foreach ($a in $accounts) {
        if ($a.LoggedIn) { $state = '로그인됨'; $color = 'Green' }
        else             { $state = '미로그인'; $color = 'Yellow' }

        $udd = Get-UserDataDir $a.Account
        if (Test-Path $udd) { $uddState = $udd } else { $uddState = '(미생성)' }

        Write-Host ("{0,-12} {1}" -f $a.Account, $a.ConfigDir)
        Write-Host ("{0,-12} 상태: " -f '') -NoNewline
        Write-Host $state -ForegroundColor $color
        Write-Host ("{0,-12} VS Code 프로필: {1}" -f '', $uddState) -ForegroundColor DarkGray
    }

    if (Test-Path $MapFile) {
        Write-Host ''
        Write-Host "경로 매핑 ($MapFile):" -ForegroundColor Cyan
        Get-Content -Path $MapFile -Raw -Encoding UTF8 | Write-Host
    }
    return
}

# ---------------------------------------------------- 대상 경로 / 계정 결정

$targetPath = (Resolve-Path -LiteralPath $Path -ErrorAction SilentlyContinue)
if (-not $targetPath) {
    throw "경로를 찾을 수 없습니다: $Path"
}
$targetPath = $targetPath.ProviderPath

if (-not $Account) {
    $Account = Resolve-AccountFromMap $targetPath
}

if (-not $Account) {
    $known = (Get-KnownAccounts | ForEach-Object { $_.Account }) -join ', '
    $msg  = "계정을 지정하세요. -Account <이름> 을 주거나 $MapFile 에 경로를 매핑하세요."
    if ($known) { $msg += "`n등록된 계정: $known" }
    throw $msg
}

$configDir = Get-ConfigDir $Account
if (-not (Test-Path $configDir)) {
    New-Item -ItemType Directory -Path $configDir -Force | Out-Null
    Write-Host "새 계정 디렉터리를 만들었습니다: $configDir" -ForegroundColor DarkGray
}

$env:CLAUDE_CONFIG_DIR = $configDir

Write-Host "계정        : $Account" -ForegroundColor Cyan
Write-Host "CONFIG_DIR  : $configDir"

# ---------------------------------------------------------------- -Login

if ($Login) {
    $claude = Resolve-ClaudeExe
    if (-not $claude) {
        throw @"
claude CLI 를 찾을 수 없습니다.
설치: npm install -g @anthropic-ai/claude-code
또는 https://claude.com/claude-code 의 설치 안내를 따르세요.
"@
    }

    Write-Host "CLI         : $claude"
    Write-Host "→ 실행 후 /login 으로 이 계정에 로그인하세요." -ForegroundColor Yellow
    Push-Location $targetPath
    try { & $claude }
    finally { Pop-Location }
    return
}

# ------------------------------------------------------------ VS Code 실행

$code = Resolve-CodeExe
if (-not $code) {
    throw "VS Code CLI(code.cmd)를 찾을 수 없습니다. VS Code에서 'Shell Command: Install code command in PATH'를 실행하세요."
}

$credFile = Join-Path $configDir '.credentials.json'
if (-not (Test-Path $credFile)) {
    Write-Host "경고: 이 계정은 아직 로그인되지 않았습니다. 먼저 -Login 으로 로그인하세요." -ForegroundColor Yellow
}

$codeArgs = @('--new-window')

if (-not $Shared) {
    $udd = Get-UserDataDir $Account
    Initialize-UserDataDir $udd
    # 별도 --user-data-dir = 별도 VS Code 프로세스 = 환경변수가 확실히 격리된다.
    $codeArgs += @('--user-data-dir', $udd)
    Write-Host "VS Code 프로필: $udd"
}
else {
    Write-Host "VS Code 프로필: (기본 공유) — 이미 실행 중인 창이 있으면 계정 분리가 깨질 수 있습니다." -ForegroundColor Yellow
}

$codeArgs += $targetPath

Write-Host "열기        : $targetPath"
& $code @codeArgs
