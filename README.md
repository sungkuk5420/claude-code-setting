# claude-code-setting

개인 Claude Code 작업환경을 **이 레포 하나로 재구축**하기 위한 설정 모음이다.
새 컴퓨터에서 `git clone` 후 설치 스크립트 한 번이면 전역 규칙·권한·훅·서브에이전트·슬래시
커맨드·스킬이 그대로 올라온다. 프로젝트별 설정(각 레포의 `CLAUDE.md`, `.claude/rules/`)은 이 레포
범위 밖이다.

## 빠른 시작

```powershell
git clone <this-repo> claude-code-setting
cd claude-code-setting
.\install.ps1              # Windows PowerShell
```

```bash
./install.sh               # Git Bash / macOS / Linux
```

- 기존 `~/.claude` 파일은 `~/.claude/backups/claude-code-setting-<시각>/` 에 백업된 뒤 덮어쓴다.
- 계정을 분리해 쓰는 경우 `CLAUDE_CONFIG_DIR` 를 설정한 채 실행하면 그 디렉토리에 설치된다.
- 훅 등록은 **다음 Claude Code 세션부터** 적용된다.
- 필수 도구: git, node(22+ 권장 — `cdp.cjs` 가 전역 WebSocket 을 쓴다), bash(Git for Windows 에 포함).
  슈퍼파워 세션 훅이 bash 로 돈다. git·node 가 없으면 설치가 중단된다.
- 설치는 **훅 스모크 테스트가 통과해야 완료를 출력한다**(settings.json 파싱, 자리표시자 잔존, 보호 브랜치 push 가
  deny 로 나오는가). 실패하면 훅이 등록은 되지만 런타임에 조용히 fail-open 되어 보호 브랜치 가드·Stop 게이트가
  동작하지 않는 상태로 세션이 시작되니 먼저 고친다. 설치 후 `claude doctor` 로 거부된 설정 항목을 볼 수 있다.

## 레포 구조

```
claude/                      ~/.claude 에 그대로 복사되는 것들
  CLAUDE.md                  전역 규칙 (WP-0 한국어, WP-1 바로 착수, PW-1~9, 코딩 원칙, 스킬 운용)
  settings.json              모델·권한·훅·worktree (__CLAUDE_DIR__ 는 설치 시 실제 경로로 치환)
  hooks/
    superpowers-session-start  SessionStart(startup|clear|compact): using-superpowers 스킬 주입 (bash)
    reinject-loop-state.cjs    SessionStart(compact|resume): 브랜치·미커밋·게이트 상태·루프 계약 재주입
    block-main-commit-push.cjs PreToolUse: main/master/DEPLOY-* 커밋·푸시 하드 차단
    record-edited-tree.cjs     PostToolUse: 편집한 트리 기록 + 테스트 파일 스냅샷 + eslint --fix
    verify-on-stop.cjs         Stop: 편집한 트리만 typecheck·test, 실패 시 완료 차단(3회, 예산 540초)
    session-end-cleanup.cjs    SessionEnd: 게이트 상태파일 정리 + 7일 잔재 청소
    reviewer-readonly.cjs      code-reviewer 전용 PreToolUse(Bash): 조회 명령만 허용(fail-closed)
    hook-log.cjs               (훅 아님) 공용 감사 로그 모듈 → ~/.claude/logs/hooks.jsonl
  agents/
    worktree-worker.md       워크트리 격리 작업자 (isolation "worktree" 디스패치, maxTurns 100)
    test-worker.md           재현→계측→수정→재검증 테스트 작업자 (maxTurns 150)
    code-reviewer.md         읽기 전용 리뷰어 (Edit/Write 제거 + reviewer-readonly 훅, maxTurns 40)
  commands/
    ultra.md                 /ultra — Workflow 오케스트레이션 옵트인
  scripts/                   계정 분리 VS Code 런처 (scripts/README.md 참고), 화면검증 cdp.cjs
skills/
  manifest.txt               npx skills 로 설치할 패키지 목록
  skill-lock.snapshot.json   설치 당시 ~/.agents/.skill-lock.json 스냅샷 (참고용)
install.ps1 / install.sh     설치 스크립트 (복사 → 스킬 → 검증)
```

## 무엇이 어디서 오나

| 구성요소 | 출처 | 갱신 방법 |
|---|---|---|
| 전역 규칙·권한·훅·에이전트·커맨드 | 이 레포 `claude/` | 레포에서 수정 → `install.ps1` 재실행 |
| 슈퍼파워 등 스킬 | `skills/manifest.txt` → `npx skills add` | `npx skills update -g` |
| claude.ai 동기화 스킬·플러그인 (`skills/synced`, `plugins/synced`) | claude.ai 계정 | 로그인 시 자동 동기화. 레포 불필요 |
| 공식 마켓플레이스 캐시 (`plugins/marketplaces`) | Claude Code 자동 | 레포 불필요 |
| MCP 서버 | 전부 claude.ai 커넥터 | claude.ai 커넥터 설정에서 인증. 로컬 설정 없음 |
| 인증·계정 (`.credentials.json`, `~/.claude.json`) | 로그인 | **절대 커밋하지 않는다** (.gitignore) |

## 권한 3층 (settings.json permissions)

1. **deny** — 되돌릴 수 없는 것: 파괴적 git(`push --force/--delete`, `reset --hard`, `clean -f`, `branch -D`,
   `commit --amend`, `--no-verify`, `rebase`, `checkout --`/`restore --worktree`/`switch --discard-changes`)을 Bash·PowerShell
   **양쪽 모두**, `git -C <dir> …` 형태까지. 비밀 파일 `.env`·`.env.*`(`.env.example`/`.sample`/`.development`/`.test` 는
   `!` 부정 규칙으로 제외). `disableBypassPermissionsMode: "disable"` 로 bypass 모드 잠금.
2. **ask** — 사람이 봐야 하는 것: `git push`(`git -C * push` 포함), `rm -r`/`Remove-Item` 류, 미설치 패키지 즉시 실행
   (`npx -y`, `npm exec`, `pnpm dlx`, `yarn dlx`, `bunx`).
3. **allow** — 조회·빌드·서브 브랜치 커밋: git 조회, `git add/switch/commit`(`git -C *` 형태 포함), npm/npx/node/테스트
   도구, PowerShell 조회 cmdlet. `git checkout` 은 allow 에서 뺐다(브랜치 생성·이동은 `switch`).

- 평가 순서는 deny → ask → allow. commit 은 allow 지만 보호 브랜치는 훅이 막는다. 훅은 fail-open 이라 git 미검출·
  타임아웃 시 통과할 수 있다(타임아웃·실행 실패는 ask 로 넘긴다, 아래 표).
- `Bash(git -C * commit:*)` 처럼 서브커맨드 앞에 `*` 가 오는 allow 규칙은 시작 시 경고를 낼 수 있다(기존
  `git -C * status:*` 와 같은 모양, 동작에는 영향 없음).
- `.env` 계열은 Read deny 라 Read/cat/head/sed/리다이렉션으로 못 읽는다(`Get-Content`·node 스크립트는 못 막으므로
  완전 차단은 아님). 값이 필요하면 채팅에 붙여넣고, 키 이름은 `.env.example` 로(이 파일은 읽기·편집 허용).
  bare 규칙은 현재 디렉토리 이하만 잡는다 — `<repo>/.claude/worktrees/` 는 포함, 형제 디렉토리의 워크트리는 제외.
- 알려진 구멍: 인자만 있는 `git restore <path>`(작업 변경 폐기)는 어느 규칙에도 안 걸려 auto 분류기 판단에 맡겨진다.
  `git restore:*` 를 ask 에 넣으면 allow 의 `git restore --staged:*` 까지 프롬프트가 뜨므로 넣지 않았다.
- bypassPermissions(`--dangerously-skip-permissions`)는 settings 로 잠가 두었다. bypass 는 auto 의 classifier 와
  `.git`/`.claude` 보호 쓰기 검사를 끄는 모드라 컨테이너 밖에서 쓸 이유가 없다. VS Code 는 토글 없이는 bypass 가
  안 보이므로 이 키는 CLI 복붙 실수를 막는 보험이다. 값은 문자열 `"disable"` 만 유효하다(`true` 는 무시됨).
  무인 루프는 기본 auto 모드로 돈다(ask 목록의 push·삭제 확인은 어느 모드에서도 유지된다).

## 훅 동작과 끄는 법

| 훅 | 이벤트 | 환경변수 | 비고 |
|---|---|---|---|
| superpowers-session-start | SessionStart `startup\|clear\|compact` | — | using-superpowers 전문 주입. `resume` 은 이력에 원래 주입이 남아 있어 제외 |
| reinject-loop-state | SessionStart `compact\|resume` | `CLAUDE_REINJECT=off` | compact: 브랜치·`git status`·최근 커밋 5·게이트 상태·`.claude/loop-contract.md`·work_log 의 미커밋/보류/미완 줄(≤1.5KB). resume: 게이트·계약만. 3초 예산, fail-open |
| block-main-commit-push | PreToolUse `Bash\|PowerShell` | `CLAUDE_GIT_GUARD=off`, `CLAUDE_PROTECTED_BRANCHES=main,master,DEPLOY-*` | 토큰 단위 `git` 만 보므로 따옴표 안(`node -e "…execSync('git push')"`)은 별도 규칙으로 deny. git 이 타임아웃(3초)·실행 실패로 브랜치를 못 알려주면 `ask`(대화형에서만 사람 확인, 헤드리스는 거부 → reason 의 재시도 안내). fail-open 은 로그에 남긴다 |
| record-edited-tree | PostToolUse `Edit\|Write\|…` | — | 트리 최초 기록 시 HEAD 테스트 파일 스냅샷·HEAD sha 저장. eslint exit 1 → exit 2 로 반환, exit≥2 는 조용히 통과(로그) |
| verify-on-stop | Stop | `CLAUDE_VERIFY_GATE=off`, `CLAUDE_VERIFY_MAX_BLOCKS`(기본 3), `CLAUDE_VERIFY_BUDGET_SEC`(기본 540, settings timeout 600 보다 작아야 함) | Claude 가 응답을 끝낼 때마다 발화하지만 편집 기록·미커밋 코드 변경이 없으면 즉시 exit(이전 턴에서 차단돼 상태파일이 남아 있으면 질문 답변 턴에도 다시 돈다). 예산 초과 시 통과한 트리를 기억하고 남은 트리만 다음 Stop 에서 이어 검증(무언 통과 없음; 시간 초과만 남으면 1회 차단 후 경고와 함께 통과). 상한 도달 시 마지막 1회는 "미해결 실패를 보고에 명시하고 종료" 지시 + 화면에 systemMessage, 다음 Stop 은 무조건 통과. 테스트 파일 순감소 차단(`<tree>/.claude/verify/test-removal.md` 로 사유 승인), `--passWithNoTests` 는 스냅샷 테스트 0개 트리만 |
| verify-on-stop 화면검증 | Stop | `CLAUDE_UI_GATE=off` | 화면 파일을 편집한 세션은 `<repo>/.claude/verify/` 에 마지막 편집 이후 증거(스크린샷 등)가 있어야 완료. 불가능하면 `ui-skip.md` 에 사유 |
| session-end-cleanup | SessionEnd `logout\|prompt_input_exit\|other` | — | 이 세션의 상태파일 삭제 + 7일 넘은 잔재 청소. `clear`/`resume` 은 제외(게이트 유지). 크래시·강제 종료에는 발화하지 않으므로 7일 스윕과 verify-on-stop 의 24시간 카운터 리셋이 주된 방어. timeout 5초 |
| reviewer-readonly | code-reviewer 의 PreToolUse `Bash`(frontmatter hooks) | — | 세그먼트마다 리다이렉션 쓰기·tee·sed -i·rm/mv·git 변경 서브커맨드를 deny, git 조회·cat/grep/find·`npx vitest <파일>` 류만 허용. 파싱 실패도 deny(fail-closed). 사용자 스코프 에이전트라 워크스페이스 trust 없이 돈다 |
| hook-log (모듈) | — | `CLAUDE_HOOK_LOG=off` | `~/.claude/logs/hooks.jsonl`(5MB 회전). git-guard 의 deny/ask/fail-open, lint 의 exit 2·조용한 통과, verify 의 block/상한/예산초과/통과, session-end 만 기록. 명령의 URL 자격증명·token 은 마스킹 |

- 상태파일: `os.tmpdir()/claude-verify-gate-<session_id>.json`(Windows `%TEMP%`, mac/Linux `$TMPDIR` 또는 `/tmp`).
  통과·상한 도달 뒤 삭제된다. 남아 있는 경우는 차단 뒤 세션을 그냥 끝냈거나 비정상 종료.
- Claude Code 자체의 Stop 훅 상한은 진행 없는 연속 8회(`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` 로 상향). 이 훅은 3회 +
  통과 1회로 그 안쪽에서 끝난다. Stop 훅은 사용자 인터럽트에는 발화하지 않는다.
- **prompt 형 Stop 훅("모든 태스크가 끝났나?")을 settings 에 상시로 넣지 않는다.** 2.1.126 당시 상한이 없어
  백그라운드 대기 중 텍스트 턴을 계속 미완으로 판정해 50분 루프가 난 사례가 있고, 현재는 8회 상한에서 하네스가
  끊고 Stop 입력의 `background_tasks` 로 대기 상태를 구분할 수 있지만, 매 턴 Haiku 호출·최대 8턴 낭비는 그대로다.
  완료 판정이 필요하면 세션 스코프 `/goal` 을 쓴다. `additionalContext` 도 대화를 계속시키므로(같은 8회 상한)
  "비차단 피드백" 이 아니다.
- 이 레포가 설치하는 `~/.claude` 의 settings·훅은 claude.ai 웹/클라우드 세션에서 읽히지 않는다(레포의
  `.claude/settings.json` 은 적용됨). 네이티브 Windows 는 Bash 샌드박스 미지원이라 allow/ask/deny 규칙 + PreToolUse 훅 +
  auto 모드 분류기(Pro/Max/Team 대화형 세션 기본값)가 경계의 전부다.
- 이 설정 레포 자체처럼 main 직접 커밋이 정상인 곳에서는 `CLAUDE_GIT_GUARD=off` 를 켜고 작업한다.

### 경계의 한계

- 훅과 Bash 규칙은 **셸 명령 텍스트만** 본다. `node script.js`·`npm run <script>`·package.json 스크립트 경유 실행은
  allow 이므로 그 안의 git/네트워크 쓰기는 하네스가 못 잡는다 — PW-2 규율과 리뷰에 의존한다. `/usr/bin/curl`,
  `sh -c '…'` 같은 형태도 규칙을 지나간다.
- `curl`/`wget`/`Invoke-WebRequest` 는 allow 에 없어서 프롬프트가 뜨는 것이 의도다. 프로젝트 `settings.local.json`
  에서 always-allow 로 올리지 말 것. 이 ask 항목들은 '가시화' 장치이지 경계가 아니다(공식 권장은 deny +
  `WebFetch(domain:…)` 대체지만 개인 환경 편의로 ask 를 택했다).
- `pnpm dlx`/`yarn dlx`/`npx -y` 가 ask 인 이유는 `Bash(yarn:*)`·`Bash(pnpm:*)`·`Bash(npx:*)` 전역 allow 때문이다.
  선의의 `node -e`·localhost curl 은 프롬프트 빈도가 변하지 않는다.

## 자율 루프 돌리기

`/loop` 은 간격 기반 폴링(최소 1분, 7일 만료, self-paced 면 Claude 가 스스로 종료 가능)이라 완료 조건을 평가하는
별도 판정자가 없다. 완료까지 도는 루프는 **`/goal`**(2.1.278 공식: 세션 스코프 prompt Stop 훅 + Haiku 평가 +
정체 감지 + 백그라운드 작업 중 평가 유예 + `-p` 지원). 서드파티 Stop 훅 루프 플러그인은 불필요하다. `/goal` 은
워크스페이스 trust 승인 + `disableAllHooks` 미설정이 전제이고, VS Code 확장에서는 슬래시 메뉴에 `/goal` 이 보이는지
먼저 확인한다.

**계약(PW-7) → /goal 조건 변환.** 조건 자체가 첫 턴의 지시이므로 ①목적을 반드시 넣는다(게이트만 있으면 작업 전에
이미 참일 수 있다). 평가기는 명령을 직접 실행하지 않고 대화에 드러난 것만 보므로 증명 방법을 조건에 넣는다.
"서브 브랜치에서" 를 넣는 이유: main 에 있으면 `block-main-commit-push` 가 커밋을 막아 클린 트리 조건이 영원히
불가능해진다. verify-on-stop 은 3회 뒤 게이트가 물러나므로 typecheck/test 출력 요구를 조건에 직접 두어야
4번째 턴부터도 게이트가 유지된다.

```
/goal <무엇이 구현·수정되어 있고(증명: 대화에 보여줄 명령 출력)> 이며, <tree> 에서 npm run typecheck 와 npm test 가
exit 0 으로 대화에 출력되었고, 서브 브랜치에서 커밋되어 git status --porcelain 이 비어 있으며, *.test.*/*.spec.* 를
삭제·skip·주석처리하지 않았다. 어떤 브랜치로도 push 하지 않는다. 20턴 넘으면 중단하고 남은 항목을 보고.
```

- 턴 상한은 평가 모델이 대화에서 판정하는 소프트 상한이다. 커밋이 필요하면 PW-2 대로 서브 브랜치에서 한다.
- verify-on-stop(결정적 회귀 게이트)과 /goal(완료 판정)은 같은 Stop 이벤트에서 함께 돈다. Stop 훅은 전부 병렬 실행되고
  하나라도 block 이면 계속되므로 충돌하지 않는다. verify-on-stop 은 `decision: block` 만 쓰므로 /goal 을 pause
  시키지 않는다(`continue: false` 를 쓰는 훅만 "Goal paused · a hook ended the turn" 을 유발).
- 시작 전 `<repo>/.claude/loop-contract.md` 에 계약 ①~⑤ 를 적어 두면 컴팩션·재개 때 reinject-loop-state 가 다시 넣어 준다.

**무인·야간 실행(PowerShell, 사람이 터미널에서 실행하는 것 — PW-4 의 `$LASTEXITCODE` 금지와 무관).** 세션당 작업 1개 +
커밋. `-p` 는 프롬프트를 띄울 수 없으므로 `permissions.ask`(push, Remove-Item 등)에 걸리는 명령은 auto 모드여도
거부된다 — 야간 루프는 커밋까지만, push 는 아침에 사람이. 헤드리스 실행 전에 feat/ 브랜치로 옮겨 두어야 커밋이 된다.
`or stop after 20 turns`(모델 판단) 외에 print 모드 전용 `--max-turns 20`(결정적, 초과 시 오류 종료)을 함께 건다.
auto 모드는 계정·모델·서버 가용성에 따라 Manual 로 폴백해 프롬프트에서 멈출 수 있으니 `--permission-prompts none`
(2.1.259+) 을 같이 준다. `$LASTEXITCODE` 는 정체 감지·impossible 종료를 잡지 못한다(프로세스는 정상 종료) — 종료
판정은 stream-json 의 `goal_status`(met/failed)를 본다. `--dangerously-skip-permissions` 는 컨테이너 밖 금지(settings
가 잠가 둠).

```powershell
$tasks = @(
  "A 기능: … 이 구현되어 있고(증명: …) …",
  "B 기능: … "
)
foreach ($t in $tasks) {
  claude -p "/goal $t 20턴 넘으면 중단하고 남은 항목을 보고." --permission-mode auto --permission-prompts none --max-turns 20 --output-format stream-json --verbose
  # 종료 판정은 $LASTEXITCODE 가 아니라 stream-json 출력의 goal_status(met/failed) 로 한다
}
```

- 긴 루프는 세션 종료·중단 시점에 `claudedocs/work_log.md`(PW-9) 항목에 "미완: …" 한 줄을 남기고, 다음 세션은
  loop-contract.md·work_log 마지막 날짜 절·`git log --oneline -10` 을 먼저 읽는다. `-p` 는 매번 새 세션이다.
- 루프가 이상하게 통과·차단됐으면 `~/.claude/logs/hooks.jsonl` 을 본다.

## 에이전트

- **worktree-worker / test-worker.** 격리 디스패치 시 WT 를 미리 만들지 않는다. 작업 내용만 넘기고(Agent 도구
  `isolation: "worktree"`), 경로·브랜치는 하네스가 정해 워커가 보고한다(변경이 있으면 워크트리가
  `<repo>/.claude/worktrees/` 에 보존됨). `settings.json` 의 `worktree.baseRef: "head"` 로 진행 중 브랜치의 HEAD 에서
  분기하고(기본 `fresh` 는 origin 기본 브랜치), `symlinkDirectories: ["node_modules"]` 로 본체의 node_modules 를
  링크한다(Windows 는 junction; 워크트리 삭제 시 링크만 지움). 링크가 안 만들어지면 워커가 lockfile 기준으로
  설치한다. 계속 작업은 `cwd` 로 그 경로에 디스패치. 머지 후 `git worktree list` 로 남은 트리를 확인하고
  `git worktree remove <경로>`(잠겨 있으면 `git worktree unlock` 먼저) + 브랜치 삭제로 정리한다(보존된 트리마다
  node_modules 링크/사본이 남으므로 방치하지 않는다). 대상 레포 `.gitignore` 에 `.claude/worktrees/` 를 넣는다.
  `maxTurns` 상한 도달 시 결과가 partial 로 반환되므로 새로 디스패치하지 말고 같은 에이전트를 resume 한다.
  워커의 편집은 `record-edited-tree` 가 부모 세션의 session_id 로 기록해 메인 Stop 에서 검증된다 — 적용 후 워커를
  한 번 돌려 `%TEMP%/claude-verify-gate-<sid>.json` 에 WT 경로가 기록되는지 1회 확인할 것(다르면 SubagentStop 훅으로
  같은 검증을 워커 단위로 붙인다).
- **code-reviewer.** Edit/Write 없음 + `reviewer-readonly.cjs` 가 Bash 를 조회 명령으로 제한. 다른 리비전은
  `git show <sha>:<path>`. partial 로 끝난 리뷰는 판정으로 쓰지 않고 diff 를 쪼개 재디스패치.
- 에이전트 파일의 `__CLAUDE_DIR__` 도 settings.json 과 같이 설치 시 치환된다(계정 분리 런처 호환).

## 화면검증 도구 `scripts/cdp.cjs`

의존성 없는 Chrome DevTools Protocol 클라이언트. Chrome/Edge/Electron 어디든 원격 디버깅 포트만 열려 있으면 붙는다.

```bash
node ~/.claude/scripts/cdp.cjs launch http://localhost:5173        # 웹앱: 브라우저를 포트 9222 로 띄움
node ~/.claude/scripts/cdp.cjs targets                             # 붙을 수 있는 페이지
node ~/.claude/scripts/cdp.cjs shot .claude/verify/after.png        # 스크린샷
node ~/.claude/scripts/cdp.cjs eval "document.title"               # JS 평가
node ~/.claude/scripts/cdp.cjs text ".error-message"               # 요소 텍스트
node ~/.claude/scripts/cdp.cjs sample "document.querySelectorAll('tr').length" 100 30   # 100ms 시계열
node ~/.claude/scripts/cdp.cjs console 5000                        # 콘솔 수집
```

Electron 앱은 메인 프로세스에 `app.commandLine.appendSwitch('remote-debugging-port', '9222')` 가 있거나 프로젝트의 verify 실행 스크립트로 띄운다. `--url <부분문자열>` 로 붙을 창을 고른다.

## 슈퍼파워 운용 메모 (2026-09-21 검증 결과)

- 스킬은 `npx skills` 로 설치되므로 스킬끼리 부르는 `superpowers:xxx` 접두어는 실제 설치명 `xxx` 와
  다르다. 공식 마켓플레이스 플러그인으로 전환하면 접두어가 맞지만, 그 경우 세션 훅을 플러그인 것으로
  바꿔야 하고 Git Bash 5.3 heredoc 문제(obra/superpowers#571)를 다시 확인해야 한다.
- `CLAUDE.md` 는 스킬과 충돌하면 이 파일을 따르도록 의도했으나 하네스 보장은 없다(둘 다 컨텍스트). 강제는 훅이
  맡는다. brainstorming 승인 게이트는 architectural 경로에서만, TDD 는 테스트 러너가 있는 프로젝트에서만 강제한다.
- ui-ux-pro-max 의 `search.py` 경로는 SKILL.md 의 `${CLAUDE_PLUGIN_ROOT}` 가 아니라
  `~/.claude/skills/ui-ux-pro-max/scripts/search.py` 다.
- `requesting-code-review` / SDD 의 리뷰 디스패치는 `general-purpose` 대신 `code-reviewer` 에이전트로.
- 서브에이전트는 SessionStart 훅을 받지 않아 using-superpowers 가 없으므로 worktree-worker/test-worker 는
  `skills:` 로 verification-before-completion(+ test-worker 는 systematic-debugging)을 사전 로드한다.

### 번들 스킬과 커스텀 도구의 역할 분담

| 번들 | 하는 일 | 이 레포의 대응물 |
|---|---|---|
| `/goal` | 완료 조건 루프(모델 평가) | verify-on-stop(결정적 게이트)과 병행 |
| `/loop` | 간격 폴링·PR 돌보기 | — (완료 루프 아님) |
| `/verify` | 수동 화면 확인(수동 호출 전용, v2.1.215+ Claude 가 스스로 부르지 않음) | `cdp.cjs` + UI 게이트 |
| `/code-review` | 적대적 리뷰 | `code-reviewer` 에이전트(읽기 전용 강제) |
| `/batch` | 워크트리 에이전트 5~30개가 각자 PR 을 연다 → push·PR 확인 규칙(PW-2)과 충돌, 이 워크플로에선 쓰지 않음 | `/ultra` + worktree-worker |
| `fewer-permission-prompts` | 프로젝트 settings 의 allow 후보 제안 | 후보 참고용(전역은 이 레포에서 수동) |

## 프로젝트에 적용하기

전역 설정은 `~/.claude` 가 담당하고, 각 레포에는 **그 레포에서 규칙을 실행하는 데 필요한 사실**만 둔다.

```bash
./templates/project/init-project.sh <프로젝트 경로> [--rules vue-options-api]
```

- `.gitignore` 에 `.claude/worktrees/`·`.claude/verify/`·`.claude/loop-contract.md`·`.superpowers/` 추가
- `claudedocs/work_log.md` 생성(PW-9)
- `--rules` 로 `templates/rules/*.md` 를 `.claude/rules/` 에 복사(예: Vue Options API 규칙)
- `CLAUDE.md` 끝에 '## Claude Code 운용' 절을 붙인다. 앱 실행 명령·포트, 검증 게이트가 돌릴 스크립트, 보호 브랜치,
  비밀 파일, 화면검증 시 켜면 안 되는 외부 쓰기 기능을 **손으로 채운다**. 이미 있으면 건드리지 않는다.
- 전역 규칙과 겹치는 프로젝트 규칙(한국어 답변, Fail Fast 등)은 프로젝트 파일에서 지운다. 적용 예: web-seolbi, seolbi-admin.

## 새 규칙·훅을 추가할 때

1. `claude/` 아래에서 수정한다 (`~/.claude` 를 직접 고치면 다음 설치 때 덮어써진다).
2. `.\install.ps1 -SkipSkills` 로 반영한다. **exit 0 이어야 반영 완료**. 훅 스모크가 실패하면 그 훅은 설치본에서
   조용히 통과(fail-open)하고 있는 것이다. 스모크는 파이프가 아니라 파일 리다이렉트로 stdin 을 넣는다(PowerShell
   BOM·인코딩 문제). 새 훅을 만들면 이 레포에서 합성 JSON 을 stdin 으로 넣어 1회 실행 검증한다:
   `printf '%s' '{"session_id":"t","tool_input":{"command":"git push origin main"},"cwd":"C:/"}' | node claude/hooks/block-main-commit-push.cjs`
3. 커밋한다. 이 레포는 `CLAUDE_GIT_GUARD=off` 상태에서 main 에 직접 커밋해도 된다.
   훅을 고쳤으면 `node tests/guard-tests.cjs claude/hooks/block-main-commit-push.cjs` 로 회귀 스위트를 돌린다(명령 텍스트를
   파일에 두는 이유: 라이브 PreToolUse 훅이 테스트 하네스의 Bash 명령 안에 든 git 커밋 문자열까지 차단한다).
4. allow 목록은 반기마다 `/permissions` 로 안 쓰는 항목을 지운다(`fewer-permission-prompts` 는 프로젝트 settings
   대상이므로 후보 참고용). 프로젝트 `settings.local.json` 에 쌓인 always-allow 도 같이 훑는다.
