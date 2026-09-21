<#
.SYNOPSIS
    이 레포의 Claude Code 설정을 사용자 설정 디렉토리(~/.claude 또는 $env:CLAUDE_CONFIG_DIR)에 적용한다.

.DESCRIPTION
    1. 기존 파일을 <설정디렉토리>\backups\claude-code-setting-<시각>\ 에 백업
    2. claude\ 아래의 CLAUDE.md / settings.json / hooks / agents / commands / scripts 를 복사
       (settings.json 과 agents\*.md 의 __CLAUDE_DIR__ 자리표시자는 실제 설정 디렉토리 경로로 치환)
    3. skills\manifest.txt 의 스킬 패키지를 npx skills 로 설치(-SkipSkills 로 생략)
    3.5 검증: settings.json 파싱·자리표시자 잔존·훅 스모크(보호 브랜치 push 가 deny 로 나오는가)·Node 22+·
       using-superpowers 존재·claude CLI. 하드 실패(exit 1)는 JSON 파싱 실패 / __CLAUDE_DIR__ 잔존 / deny 미검출 셋뿐,
       나머지는 경고. -DryRun 이면 검증 생략(도구 점검은 수행).
    4. 필수 도구(git, node, bash) 존재 여부 점검 — git·node 가 없으면 중단

.PARAMETER SkipSkills
    npx skills 설치 단계를 건너뛴다.

.PARAMETER DryRun
    실제로 복사하지 않고 무엇을 할지 출력만 한다.

.EXAMPLE
    .\install.ps1
    .\install.ps1 -SkipSkills
    $env:CLAUDE_CONFIG_DIR = "$env:USERPROFILE\.claude-work"; .\install.ps1
#>
[CmdletBinding()]
param(
    [switch]$SkipSkills,
    [switch]$DryRun,
    # 다른 설정 디렉토리(예: ~/.claude-cursor)에 설치할 때, npx skills 가 ~/.claude/skills 에만 설치하므로
    # 그 폴더의 스킬을 정션(junction)으로 연결한다. 예: -LinkSkillsFrom "$env:USERPROFILE\.claude\skills"
    [string]$LinkSkillsFrom
)

$ErrorActionPreference = 'Stop'

$Repo = $PSScriptRoot
$Src = Join-Path $Repo 'claude'
$Target = if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { Join-Path $env:USERPROFILE '.claude' }
$Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$BackupDir = Join-Path $Target "backups\claude-code-setting-$Stamp"

function Say([string]$msg) { Write-Host "[install] $msg" }

Say "레포:        $Repo"
Say "설정 디렉토리: $Target"
if ($DryRun) { Say '(DryRun: 파일을 쓰지 않습니다)' }

# --- 0. 도구 점검 ----------------------------------------------------------
foreach ($tool in @('git', 'node')) {
    $cmd = Get-Command $tool -ErrorAction SilentlyContinue
    if ($cmd) { Say "OK  $tool -> $($cmd.Source)" }
    else { throw "$tool 을(를) 찾을 수 없습니다. 훅과 스킬 설치에 필요합니다(설치 중단)." }
}
try {
    $nodeVer = (& node --version) -replace '^v', ''
    $nodeMajor = [int](($nodeVer -split '\.')[0])
    if ($nodeMajor -lt 22) { Write-Warning "Node $nodeVer — cdp.cjs 는 전역 WebSocket 이 필요해 Node 22+ 를 권장합니다." }
} catch { Write-Warning "Node 버전을 읽지 못했습니다: $($_.Exception.Message)" }
# bash 는 Git for Windows 것이어야 한다. WindowsApps\bash.exe 는 WSL 스텁이라 훅에 못 쓴다.
$gitBash = Join-Path $env:ProgramFiles 'Git\bin\bash.exe'
if (Test-Path $gitBash) { Say "OK  bash -> $gitBash (Git for Windows)" }
else { Write-Warning "Git for Windows 의 bash.exe 를 찾을 수 없습니다 ($gitBash). 슈퍼파워 세션 훅은 bash 로 실행됩니다." }

if (-not $DryRun) {
    New-Item -ItemType Directory -Force -Path $Target | Out-Null
    New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null
}

function Install-File([string]$RelPath, [scriptblock]$Transform) {
    $from = Join-Path $Src $RelPath
    $to = Join-Path $Target $RelPath
    $toDir = Split-Path $to -Parent
    if (Test-Path $to) {
        $bak = Join-Path $BackupDir $RelPath
        Say "백업  $RelPath"
        if (-not $DryRun) {
            New-Item -ItemType Directory -Force -Path (Split-Path $bak -Parent) | Out-Null
            Copy-Item $to $bak -Force
        }
    }
    Say "복사  $RelPath"
    if ($DryRun) { return }
    New-Item -ItemType Directory -Force -Path $toDir | Out-Null
    if ($Transform) {
        $content = Get-Content $from -Raw -Encoding UTF8
        $content = & $Transform $content
        [System.IO.File]::WriteAllText($to, $content, (New-Object System.Text.UTF8Encoding($false)))
    } else {
        Copy-Item $from $to -Force
    }
}

# --- 1. 단일 파일 ----------------------------------------------------------
Install-File 'CLAUDE.md'
$dirForward = $Target -replace '\\', '/'
Install-File 'settings.json' { param($c) $c -replace '__CLAUDE_DIR__', $dirForward }

# --- 2. 디렉토리(파일 단위 복사, 기존의 다른 파일은 보존) ------------------------
foreach ($dir in @('hooks', 'agents', 'commands', 'scripts')) {
    $srcDir = Join-Path $Src $dir
    if (-not (Test-Path $srcDir)) { continue }
    Get-ChildItem $srcDir -File | ForEach-Object {
        $rel = Join-Path $dir $_.Name
        # account-map.json 은 머신별 파일 — 이미 있으면 건드리지 않는다
        if ($rel -like '*account-map.json' -and (Test-Path (Join-Path $Target $rel))) { Say "유지  $rel"; return }
        # agents\*.md 의 frontmatter hooks 도 절대경로가 필요하다(경로가 틀리면 훅이 소리 없이 꺼진다).
        # 새 훅 파일은 hooks\ 에 두기만 하면 이 루프가 자동으로 복사한다.
        if ($dir -eq 'agents') { Install-File $rel { param($c) $c -replace '__CLAUDE_DIR__', $dirForward } }
        else { Install-File $rel }
    }
}

# --- 3. 스킬 ----------------------------------------------------------------
if ($SkipSkills) {
    Say '스킬 설치 생략(-SkipSkills)'
} else {
    $manifest = Join-Path $Repo 'skills\manifest.txt'
    $lines = Get-Content $manifest -Encoding UTF8 | Where-Object { $_.Trim() -and -not $_.Trim().StartsWith('#') }
    foreach ($line in $lines) {
        $parts = $line.Trim() -split '\s+', 2
        $pkg = $parts[0]
        $skills = if ($parts.Count -gt 1 -and $parts[1]) { $parts[1] } else { '*' }
        Say "스킬  npx skills add $pkg -g -y --copy -a claude-code -s $skills"
        if (-not $DryRun) {
            & npx -y skills add $pkg -g -y --copy -a claude-code -s $skills
            if ($LASTEXITCODE -ne 0) { Write-Warning "스킬 설치 실패: $pkg (exit $LASTEXITCODE)" }
        }
    }
}

# --- 3.1 스킬 정션 (프로필 분리 시) -------------------------------------------
if ($LinkSkillsFrom) {
    $dstSkills = Join-Path $Target 'skills'
    if (-not (Test-Path $LinkSkillsFrom)) { Write-Warning "LinkSkillsFrom 경로가 없습니다: $LinkSkillsFrom" }
    else {
        if (-not $DryRun) { New-Item -ItemType Directory -Force -Path $dstSkills | Out-Null }
        Get-ChildItem $LinkSkillsFrom -Directory | Where-Object { $_.Name -ne 'synced' } | ForEach-Object {
            $t = Join-Path $dstSkills $_.Name
            if (Test-Path -LiteralPath $t) { Say "스킬  유지 $($_.Name)" }
            else { Say "스킬  정션 $($_.Name) -> $($_.FullName)"; if (-not $DryRun) { New-Item -ItemType Junction -Path $t -Target $_.FullName | Out-Null } }
        }
    }
}

# --- 3.5 검증 ---------------------------------------------------------------
# 하드 실패는 $failed 에 모아 마지막에 전부 출력하고 exit 1 (ErrorActionPreference=Stop 에서 Write-Error 는 첫 호출에서
# 종료돼 나머지 결과가 안 보인다). 경고는 Write-Warning.
$failed = @()
if (-not $DryRun) {
    # (1) settings.json 파싱 + 자리표시자 잔존
    $settingsPath = Join-Path $Target 'settings.json'
    $settingsRaw = Get-Content $settingsPath -Raw -Encoding UTF8
    try { $null = $settingsRaw | ConvertFrom-Json; Say 'OK  settings.json 은 유효한 JSON' }
    catch { $failed += "settings.json 이 유효한 JSON 이 아닙니다: $($_.Exception.Message)" }
    if ($settingsRaw -match '__CLAUDE_DIR__') { $failed += 'settings.json 에 __CLAUDE_DIR__ 자리표시자가 남아 있습니다' }
    Get-ChildItem (Join-Path $Target 'agents') -File -Filter *.md -ErrorAction SilentlyContinue | ForEach-Object {
        if ((Get-Content $_.FullName -Raw -Encoding UTF8) -match '__CLAUDE_DIR__') { $failed += "agents\$($_.Name) 에 __CLAUDE_DIR__ 가 남아 있습니다" }
    }

    # (2) 백업본과 permissions 차이(정보만 — 레포가 source of truth)
    $bakSettings = Join-Path $BackupDir 'settings.json'
    if (Test-Path $bakSettings) {
        try {
            $old = Get-Content $bakSettings -Raw -Encoding UTF8 | ConvertFrom-Json
            $new = $settingsRaw | ConvertFrom-Json
            foreach ($k in @('allow', 'ask', 'deny')) {
                $o = @($old.permissions.$k); $n = @($new.permissions.$k)
                $onlyOld = @($o | Where-Object { $n -notcontains $_ })
                if ($onlyOld.Count -gt 0) { Say "정보: permissions.$k 에서 백업본에만 있는 규칙 $($onlyOld.Count)개(설치 후 수동으로 추가된 것): $($onlyOld -join ', ')" }
            }
        } catch { Write-Warning "백업본 permissions 비교 실패: $($_.Exception.Message)" }
    }

    # (3) 훅 스모크. stdin 은 파이프가 아니라 BOM 없는 임시파일 리다이렉트로 넣는다(PowerShell 5.1 파이프는 인코딩이
    #     깨질 수 있다). 이 레포 작업 세션(CLAUDE_GIT_GUARD=off)에서 돌려도 거짓 실패하지 않도록 관련 변수를 잠시 비운다.
    $savedEnv = @{}
    foreach ($v in @('CLAUDE_GIT_GUARD', 'CLAUDE_PROTECTED_BRANCHES', 'CLAUDE_VERIFY_GATE', 'CLAUDE_HOOK_LOG')) {
        $savedEnv[$v] = [Environment]::GetEnvironmentVariable($v, 'Process')
        [Environment]::SetEnvironmentVariable($v, $null, 'Process')
    }
    $env:CLAUDE_HOOK_LOG = 'off'
    $smokeSid = "install-smoke-$Stamp"
    $smokeTmp = Join-Path ([IO.Path]::GetTempPath()) "claude-install-smoke-$Stamp.json"
    function Invoke-HookSmoke([string]$Hook, [string]$Json) {
        $hookPath = Join-Path $Target "hooks\$Hook"
        [IO.File]::WriteAllText($smokeTmp, $Json, (New-Object Text.UTF8Encoding($false)))
        $out = & cmd /c "node ""$hookPath"" < ""$smokeTmp"" 2>&1"
        return @{ code = $LASTEXITCODE; out = (@($out) -join "`n") }
    }
    try {
        $r = Invoke-HookSmoke 'block-main-commit-push.cjs' "{`"session_id`":`"$smokeSid`",`"tool_input`":{`"command`":`"git push origin main`"},`"cwd`":`"$dirForward`"}"
        if ($r.out -match '"permissionDecision":"deny"') { Say 'OK  block-main-commit-push: 보호 브랜치 push -> deny' }
        else { $failed += "block-main-commit-push 가 'git push origin main' 을 deny 하지 않습니다(가드가 죽은 채 설치됨): exit $($r.code) $($r.out)" }
        foreach ($h in @('record-edited-tree.cjs', 'verify-on-stop.cjs', 'session-end-cleanup.cjs')) {
            $r = Invoke-HookSmoke $h "{`"session_id`":`"$smokeSid`",`"reason`":`"other`"}"
            if ($r.code -eq 0) { Say "OK  $h 로드" } else { Write-Warning "$h 가 exit 0 이 아닙니다(exit $($r.code)): $($r.out)" }
        }
        $r = Invoke-HookSmoke 'reinject-loop-state.cjs' "{`"session_id`":`"$smokeSid`",`"cwd`":`"$dirForward`",`"source`":`"resume`"}"
        try { $null = $r.out | ConvertFrom-Json; Say 'OK  reinject-loop-state: JSON 출력' } catch { Write-Warning "reinject-loop-state 출력이 JSON 이 아닙니다: $($r.out)" }
        $r = Invoke-HookSmoke 'reviewer-readonly.cjs' "{`"session_id`":`"$smokeSid`",`"tool_input`":{`"command`":`"rm -rf x`"}}"
        if ($r.out -match '"permissionDecision":"deny"') { Say 'OK  reviewer-readonly: rm -> deny' } else { Write-Warning "reviewer-readonly 가 'rm -rf x' 를 deny 하지 않습니다: $($r.out)" }
    } finally {
        Remove-Item $smokeTmp -Force -ErrorAction SilentlyContinue
        Get-ChildItem ([IO.Path]::GetTempPath()) -Filter 'claude-verify-gate-install-smoke-*.json' -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
        foreach ($v in $savedEnv.Keys) { [Environment]::SetEnvironmentVariable($v, $savedEnv[$v], 'Process') }
    }

    # (4) 세션 훅 + using-superpowers (스킬 단계 뒤에서만 의미 있음)
    $skillMd = Join-Path $Target 'skills\using-superpowers\SKILL.md'
    if (-not $SkipSkills -and -not (Test-Path $skillMd)) { Write-Warning "$skillMd 없음 — 세션 훅이 조용히 아무것도 주입하지 않습니다." }
    if (Test-Path $gitBash) {
        $hookFwd = "$dirForward/hooks/superpowers-session-start"
        $sessionOut = ''
        try { $sessionOut = (@(& $gitBash -c "bash '$hookFwd' 2>/dev/null") -join "`n") } catch { $sessionOut = '' }
        if ($sessionOut.Trim()) {
            try { $null = $sessionOut | ConvertFrom-Json; Say 'OK  superpowers-session-start: JSON 출력' }
            catch { Write-Warning 'superpowers-session-start 출력이 JSON 이 아닙니다.' }
        } elseif (Test-Path $skillMd) { Write-Warning 'superpowers-session-start 출력이 비어 있습니다(스킬은 존재).' }
        else { Say '정보: superpowers-session-start 출력 없음(스킬 미설치)' }
    }

    # (5) claude CLI
    $claudeCmd = Get-Command claude -ErrorAction SilentlyContinue
    if ($claudeCmd) { try { Say "OK  claude -> $((& claude --version 2>$null | Select-Object -First 1))" } catch { Say "OK  claude -> $($claudeCmd.Source)" } }
    else { Write-Warning 'claude CLI 를 찾을 수 없습니다.' }
}

# --- 4. 마무리 --------------------------------------------------------------
if (-not $DryRun) {
    $count = (Get-ChildItem $BackupDir -Recurse -File -ErrorAction SilentlyContinue | Measure-Object).Count
    if ($count -eq 0) { Remove-Item $BackupDir -Recurse -Force -ErrorAction SilentlyContinue }
    else { Say "백업 위치: $BackupDir ($count 개 파일)" }
}
if ($failed.Count -gt 0) {
    foreach ($m in $failed) { Say "실패: $m" }
    Say '검증 실패 — 위 항목을 고치고 다시 실행하라(이 상태로 세션을 시작하면 훅이 fail-open 으로 돈다).'
    exit 1
}
Say '완료. 훅 등록은 다음 Claude Code 세션부터 적용됩니다.'
Say '계정 분리 런처를 쓰려면: scripts\README.md 참고 ($PROFILE 에 profile-snippet.ps1 dot-source)'
