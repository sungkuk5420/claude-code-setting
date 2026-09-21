# Claude Code 계정 분리 실행 (Windows / PowerShell)

VS Code의 Claude Code 확장은 **VS Code를 띄운 프로세스의 환경변수**를 물려받는다.
따라서 `CLAUDE_CONFIG_DIR`를 설정한 뒤 VS Code를 실행하면 창 단위로 계정이 갈린다.

## 파일

| 파일 | 역할 |
|------|------|
| `Start-ClaudeCode.ps1` | 메인 런처. 계정 지정 → 환경변수 설정 → VS Code 또는 claude CLI 실행 |
| `profile-snippet.ps1` | `code-work` / `code-personal` 등 단축 함수. $PROFILE에서 dot-source |
| `account-map.json` | 저장소 경로 → 계정 자동 매핑 (선택) |
| `account-map.example.json` | 매핑 작성 예시 |

## 1. 계정별 최초 로그인 (한 번씩)

```powershell
& "$env:USERPROFILE\.claude\scripts\Start-ClaudeCode.ps1" -Account work -Login
& "$env:USERPROFILE\.claude\scripts\Start-ClaudeCode.ps1" -Account personal -Login
```

claude CLI가 뜨면 `/login` 으로 각각 로그인한다.
`CLAUDE_CONFIG_DIR`는 각각 `%USERPROFILE%\.claude-work`, `%USERPROFILE%\.claude-personal` 로 설정된다.

> CLI가 PATH에 없으면 VS Code 확장에 번들된 `claude.exe`를 자동으로 찾아 쓴다.
> 정식 설치를 원하면: `npm install -g @anthropic-ai/claude-code`

## 2. 저장소별 VS Code 실행

```powershell
& "$env:USERPROFILE\.claude\scripts\Start-ClaudeCode.ps1" -Account work     C:\repos\work-repo
& "$env:USERPROFILE\.claude\scripts\Start-ClaudeCode.ps1" -Account personal C:\repos\side-repo
```

## 3. 단축 함수 등록 (권장)

`$PROFILE` 파일에 아래 한 줄을 추가한다.

```powershell
if (-not (Test-Path $PROFILE)) { New-Item -ItemType File -Path $PROFILE -Force }
Add-Content -Path $PROFILE -Encoding UTF8 -Value '. "$env:USERPROFILE\.claude\scripts\profile-snippet.ps1"'
```

새 PowerShell 창부터 사용 가능:

```powershell
cd C:\repos\work-repo ; code-work .
cd C:\repos\side-repo ; code-personal .
ccode-list                     # 계정 목록 + 로그인 상태
ccode work C:\repos\other      # 임의 계정
```

## 4. 경로 자동 매핑 (선택)

`account-map.json`에 저장소 경로 → 계정을 적어두면 `-Account` 없이 실행할 수 있다.
가장 긴 경로 접두사가 우선한다.
역슬래시는 위 예시처럼 하나만 써도 되고 표준 JSON식 이중(`\\`)도 되며, 슬래시(`/`)도 허용된다.

```json
{
  "C:\Users\sungk\Documents\web-seolbi": "work",
  "C:\Users\sungk\repos\side": "personal"
}
```

```powershell
cd C:\Users\sungk\Documents\web-seolbi ; ccode
```

## 왜 `--user-data-dir`를 분리하는가

VS Code가 **이미 실행 중**이면 `code .`는 새 프로세스를 만들지 않고 기존 메인 프로세스에
창만 추가한다. 그러면 새 창은 **예전 환경변수**를 그대로 물려받아 계정 분리가 깨진다.

이 스크립트는 기본적으로 계정별 `--user-data-dir`(`%LOCALAPPDATA%\vscode-claude-<계정>`)을
지정해 **별도 VS Code 프로세스**를 강제한다.

- 확장 목록은 `--extensions-dir` 기본값(`~\.vscode\extensions`)을 공유하므로 재설치 불필요.
- 프로필 최초 생성 시 기본 `settings.json` / `keybindings.json` / `snippets`를 복사해 초기 상태를 맞춘다.
- 기본 프로필을 그대로 쓰려면 `-Shared` 스위치를 준다 (VS Code가 이미 떠 있으면 분리 실패 가능).

## 확인 방법

VS Code 창에서 터미널을 열고:

```powershell
$env:CLAUDE_CONFIG_DIR
```

기대한 계정 디렉터리가 나오면 확장도 같은 값을 쓴다.
(확장은 `CLAUDE_CONFIG_DIR`가 설정되면 IDE 잠금 파일도 `$CLAUDE_CONFIG_DIR\ide\` 에 쓴다.)
