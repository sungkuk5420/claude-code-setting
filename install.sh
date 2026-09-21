#!/usr/bin/env bash
# 이 레포의 Claude Code 설정을 사용자 설정 디렉토리(~/.claude 또는 $CLAUDE_CONFIG_DIR)에 적용한다.
# Git Bash(Windows) / macOS / Linux 공통. Windows 에서는 install.ps1 을 써도 된다(동일 동작).
#
#   ./install.sh                 전체 설치
#   ./install.sh --skip-skills   npx skills 단계 생략
#   ./install.sh --dry-run       무엇을 할지 출력만(검증 단계도 생략)
#
# 단계: 0 도구 점검 → 1·2 복사(settings.json·agents/*.md 의 __CLAUDE_DIR__ 치환) → 3 스킬 → 3.5 검증 → 4 마무리
# 검증에서 하드 실패(exit 1)하는 것: settings.json 파싱 실패 / __CLAUDE_DIR__ 잔존 / 보호 브랜치 push 가 deny 로 안 나옴.
# 나머지(Node<22, using-superpowers 부재, claude CLI 부재, 보조 훅 스모크)는 경고.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$REPO/claude"
TARGET="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP="$TARGET/backups/claude-code-setting-$STAMP"
SKIP_SKILLS=0; DRY=0
for a in "$@"; do
  case "$a" in
    --skip-skills) SKIP_SKILLS=1 ;;
    --dry-run) DRY=1 ;;
    *) echo "unknown option: $a" >&2; exit 2 ;;
  esac
done

say() { printf '[install] %s\n' "$*"; }
say "레포:          $REPO"
say "설정 디렉토리: $TARGET"
[ "$DRY" = 1 ] && say "(dry-run: 파일을 쓰지 않습니다)"

# --- 0. 도구 점검 ------------------------------------------------------------
for t in git node; do
  if command -v "$t" >/dev/null 2>&1; then say "OK  $t -> $(command -v "$t")"
  else echo "[install] 오류: $t 없음 — 훅과 스킬 설치에 필요" >&2; exit 1; fi
done
node_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "${node_major:-0}" -lt 22 ]; then say "경고: Node $(node --version 2>/dev/null) — cdp.cjs 는 전역 WebSocket 이 필요해 Node 22+ 를 권장"; fi
# Claude Code 가 쓰는 bash 는 자체 탐색 결과이지 이 스크립트의 셸이 아니다. Windows 는 Git for Windows 의 bash 여야 한다.
HOOK_BASH="bash"
case "$(uname -s 2>/dev/null || echo '')" in
  MINGW*|MSYS*|CYGWIN*)
    if [ -x "/c/Program Files/Git/bin/bash.exe" ]; then HOOK_BASH="/c/Program Files/Git/bin/bash.exe"; say "OK  bash -> $HOOK_BASH (Git for Windows)"
    else say "경고: Git for Windows 의 bash.exe 를 찾을 수 없음 — 슈퍼파워 세션 훅은 bash 로 실행된다"; fi ;;
  *) if command -v bash >/dev/null 2>&1; then say "OK  bash -> $(command -v bash)"; else say "경고: bash 없음"; fi ;;
esac

[ "$DRY" = 1 ] || mkdir -p "$TARGET" "$BACKUP"

# Windows Git Bash 에서는 훅 명령에 C:/... 형태가 안전하다.
target_fwd="$TARGET"
if command -v cygpath >/dev/null 2>&1; then target_fwd="$(cygpath -m "$TARGET")"; fi

install_file() { # install_file <rel> [transform: sed 식]
  local rel="$1" from="$SRC/$1" to="$TARGET/$1"
  if [ -e "$to" ]; then
    say "백업  $rel"
    if [ "$DRY" = 0 ]; then mkdir -p "$(dirname "$BACKUP/$rel")"; cp "$to" "$BACKUP/$rel"; fi
  fi
  say "복사  $rel"
  [ "$DRY" = 1 ] && return 0
  mkdir -p "$(dirname "$to")"
  if [ "${2:-}" ]; then sed "$2" "$from" > "$to"; else cp "$from" "$to"; fi
}

# --- 1·2. 복사 ----------------------------------------------------------------
install_file CLAUDE.md
install_file settings.json "s|__CLAUDE_DIR__|$target_fwd|g"

for dir in hooks agents commands scripts; do
  [ -d "$SRC/$dir" ] || continue
  for f in "$SRC/$dir"/*; do
    [ -f "$f" ] || continue
    rel="$dir/$(basename "$f")"
    if [ "$rel" = "scripts/account-map.json" ] && [ -e "$TARGET/$rel" ]; then say "유지  $rel"; continue; fi
    # agents/*.md 의 frontmatter hooks 도 절대경로가 필요하다(경로가 틀리면 훅이 소리 없이 꺼진다).
    if [ "$dir" = agents ]; then install_file "$rel" "s|__CLAUDE_DIR__|$target_fwd|g"; else install_file "$rel"; fi
  done
done
[ "$DRY" = 1 ] || chmod +x "$TARGET"/hooks/* 2>/dev/null || true

# --- 3. 스킬 --------------------------------------------------------------------
if [ "$SKIP_SKILLS" = 1 ]; then
  say "스킬 설치 생략(--skip-skills)"
else
  while IFS= read -r line; do
    line="${line%%#*}"; line="$(echo "$line" | xargs 2>/dev/null || true)"
    [ -z "$line" ] && continue
    pkg="${line%% *}"; skills="${line#"$pkg"}"; skills="$(echo "$skills" | xargs 2>/dev/null || true)"
    [ -z "$skills" ] && skills='*'
    say "스킬  npx skills add $pkg -g -y --copy -a claude-code -s $skills"
    if [ "$DRY" = 0 ]; then
      npx -y skills add "$pkg" -g -y --copy -a claude-code -s "$skills" || say "경고: 스킬 설치 실패: $pkg"
    fi
  done < "$REPO/skills/manifest.txt"
fi

# --- 3.5 검증 -------------------------------------------------------------------
failed=()
if [ "$DRY" = 0 ]; then
  # (1) settings.json 파싱 + 자리표시자 잔존
  if node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$TARGET/settings.json" 2>/dev/null; then say "OK  settings.json 은 유효한 JSON"
  else failed+=("settings.json 이 유효한 JSON 이 아닙니다"); fi
  if grep -q '__CLAUDE_DIR__' "$TARGET/settings.json"; then failed+=("settings.json 에 __CLAUDE_DIR__ 자리표시자가 남아 있습니다"); fi
  for f in "$TARGET"/agents/*.md; do
    [ -f "$f" ] || continue
    if grep -q '__CLAUDE_DIR__' "$f"; then failed+=("agents/$(basename "$f") 에 __CLAUDE_DIR__ 가 남아 있습니다"); fi
  done

  # (2) 백업본과 permissions 차이(정보만)
  if [ -f "$BACKUP/settings.json" ]; then
    node -e '
      const fs=require("fs"); const [o,n]=process.argv.slice(1).map(p=>JSON.parse(fs.readFileSync(p,"utf8")));
      for (const k of ["allow","ask","deny"]) {
        const a=(o.permissions||{})[k]||[], b=new Set(((n.permissions||{})[k]||[]));
        const only=a.filter(x=>!b.has(x));
        if (only.length) console.log(`[install] 정보: permissions.${k} 에서 백업본에만 있는 규칙 ${only.length}개(설치 후 수동으로 추가된 것): ${only.join(", ")}`);
      }' "$BACKUP/settings.json" "$TARGET/settings.json" 2>/dev/null || say "경고: 백업본 permissions 비교 실패"
  fi

  # (3) 훅 스모크 — 이 레포 작업 세션(CLAUDE_GIT_GUARD=off)에서 돌려도 거짓 실패하지 않도록 관련 변수를 비운다.
  smoke_sid="install-smoke-$STAMP"
  smoke() { # smoke <hook> <json>  → stdout 출력, 종료코드는 $?
    printf '%s' "$2" | env -u CLAUDE_GIT_GUARD -u CLAUDE_PROTECTED_BRANCHES -u CLAUDE_VERIFY_GATE CLAUDE_HOOK_LOG=off node "$TARGET/hooks/$1" 2>/dev/null
  }
  out="$(smoke block-main-commit-push.cjs "{\"session_id\":\"$smoke_sid\",\"tool_input\":{\"command\":\"git push origin main\"},\"cwd\":\"$target_fwd\"}" || true)"
  if printf '%s' "$out" | grep -q '"permissionDecision":"deny"'; then say "OK  block-main-commit-push: 보호 브랜치 push → deny"
  else failed+=("block-main-commit-push 가 'git push origin main' 을 deny 하지 않습니다(가드가 죽은 채 설치됨): $out"); fi
  for h in record-edited-tree.cjs verify-on-stop.cjs session-end-cleanup.cjs; do
    if smoke "$h" "{\"session_id\":\"$smoke_sid\",\"reason\":\"other\"}" >/dev/null; then say "OK  $h 로드"
    else say "경고: $h 가 exit 0 이 아닙니다"; fi
  done
  out="$(smoke reinject-loop-state.cjs "{\"session_id\":\"$smoke_sid\",\"cwd\":\"$target_fwd\",\"source\":\"resume\"}" || true)"
  if printf '%s' "$out" | node -e 'JSON.parse(require("fs").readFileSync(0,"utf8"))' 2>/dev/null; then say "OK  reinject-loop-state: JSON 출력"
  else say "경고: reinject-loop-state 출력이 JSON 이 아닙니다"; fi
  out="$(smoke reviewer-readonly.cjs "{\"session_id\":\"$smoke_sid\",\"tool_input\":{\"command\":\"rm -rf x\"}}" || true)"
  if printf '%s' "$out" | grep -q '"permissionDecision":"deny"'; then say "OK  reviewer-readonly: rm → deny"
  else say "경고: reviewer-readonly 가 'rm -rf x' 를 deny 하지 않습니다"; fi
  rm -f "${TMPDIR:-/tmp}"/claude-verify-gate-install-smoke-*.json "${TEMP:-/tmp}"/claude-verify-gate-install-smoke-*.json 2>/dev/null || true

  # (4) 세션 훅 + using-superpowers (스킬 단계 뒤에서만 의미 있음)
  skill_md="$TARGET/skills/using-superpowers/SKILL.md"
  if [ "$SKIP_SKILLS" = 0 ] && [ ! -f "$skill_md" ]; then
    say "경고: $skill_md 없음 — 세션 훅이 조용히 아무것도 주입하지 않는다"
  fi
  hook_fwd="$target_fwd/hooks/superpowers-session-start"
  out="$("$HOOK_BASH" "$hook_fwd" 2>/dev/null || true)"
  if [ -n "$out" ]; then
    if printf '%s' "$out" | node -e 'JSON.parse(require("fs").readFileSync(0,"utf8"))' 2>/dev/null; then say "OK  superpowers-session-start: JSON 출력"
    else say "경고: superpowers-session-start 출력이 JSON 이 아닙니다"; fi
  elif [ -f "$skill_md" ]; then say "경고: superpowers-session-start 출력이 비어 있습니다(스킬은 존재)"
  else say "정보: superpowers-session-start 출력 없음(스킬 미설치)"; fi

  # (5) claude CLI
  if command -v claude >/dev/null 2>&1; then say "OK  claude -> $(claude --version 2>/dev/null | head -1)"
  else say "경고: claude CLI 를 찾을 수 없음"; fi
fi

# --- 4. 마무리 ------------------------------------------------------------------
if [ "$DRY" = 0 ]; then
  n=$(find "$BACKUP" -type f 2>/dev/null | wc -l | tr -d ' ')
  if [ "$n" = 0 ]; then rm -rf "$BACKUP"; else say "백업 위치: $BACKUP ($n 개 파일)"; fi
fi
if [ "${#failed[@]}" -gt 0 ]; then
  for m in "${failed[@]}"; do say "실패: $m"; done
  say "검증 실패 — 위 항목을 고치고 다시 실행하라(이 상태로 세션을 시작하면 훅이 fail-open 으로 돈다)."
  exit 1
fi
say "완료. 훅 등록은 다음 Claude Code 세션부터 적용됩니다."
