# ---------------------------------------------------------------------------
# Claude Code 계정 분리 실행 헬퍼
# 사용법: PowerShell 프로필($PROFILE)에 아래 한 줄을 추가하고 새 창을 연다.
#   . "$env:USERPROFILE\.claude\scripts\profile-snippet.ps1"
# ---------------------------------------------------------------------------

$script:ClaudeLauncher = Join-Path $env:USERPROFILE '.claude\scripts\Start-ClaudeCode.ps1'

function ccode {
    <# 계정을 직접 지정해 VS Code 실행. 예: ccode work C:\repos\work-repo #>
    & $script:ClaudeLauncher @args
}

function code-work {
    <# 회사 계정으로 VS Code 실행. 예: code-work . #>
    param([string]$Path = '.')
    & $script:ClaudeLauncher -Account work -Path $Path
}

function code-personal {
    <# 개인 계정으로 VS Code 실행. 예: code-personal . #>
    param([string]$Path = '.')
    & $script:ClaudeLauncher -Account personal -Path $Path
}

function claude-work {
    <# 회사 계정 환경으로 claude CLI 실행 (/login 용) #>
    param([string]$Path = '.')
    & $script:ClaudeLauncher -Account work -Path $Path -Login
}

function claude-personal {
    <# 개인 계정 환경으로 claude CLI 실행 (/login 용) #>
    param([string]$Path = '.')
    & $script:ClaudeLauncher -Account personal -Path $Path -Login
}

function ccode-list {
    <# 등록된 계정과 로그인 상태 확인 #>
    & $script:ClaudeLauncher -List
}
