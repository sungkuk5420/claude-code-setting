## Claude Code 운용

> 전역 규칙(`~/.claude/CLAUDE.md`)이 협업·안전 원칙을 정하고, 이 절은 **이 레포에서 그 규칙을 실행하는 데
> 필요한 사실**만 적는다. 값이 바뀌면 여기를 고친다.

| 항목 | 값 |
|---|---|
| 앱 실행 | `<실행 명령>` → `http://localhost:<포트>` |
| 화면검증(PW-6) | `node ~/.claude/scripts/cdp.cjs launch http://localhost:<포트>` → `cdp.cjs shot .claude/verify/after.png` |
| 검증 게이트(Stop 훅) | typecheck: `<명령 또는 없음>` / test: `<명령 또는 없음>` (package.json 스크립트 기준으로 자동 실행) |
| 보호 브랜치 | `main`, `master`<, 배포 브랜치 패턴> — 서브 브랜치에서 작업하고 MR/PR |
| 작업 로그(PW-9) | `claudedocs/work_log.md` |
| 워크트리 | `.claude/worktrees/` (git-ignored). 워크트리에서는 `npm ci` 먼저 |
| 비밀 파일 | `.env*` 는 읽지 않는다. 키 이름은 `.env.example` 에 |

<프로젝트 특이사항: 테스트 러너 유무, 화면검증 시 로그인 방법, 외부 쓰기가 나가는 기능(켜지 말 것) 등>
