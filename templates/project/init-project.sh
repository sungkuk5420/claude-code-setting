#!/usr/bin/env bash
# 프로젝트에 Claude Code 운용 골격을 넣는다. 멱등: 이미 있는 것은 건드리지 않는다.
#   ./templates/project/init-project.sh <프로젝트 경로> [--rules vue-options-api]
# 하는 일: .gitignore 에 snippet 추가 / claudedocs/work_log.md 생성 / .claude/rules/<rule>.md 복사 /
#          CLAUDE.md 에 '## Claude Code 운용' 절이 없으면 템플릿을 끝에 붙인다(자리표시자는 손으로 채운다).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="${1:?프로젝트 경로}"; shift || true
RULES=()
while [ $# -gt 0 ]; do case "$1" in --rules) RULES+=("$2"); shift 2 ;; *) echo "unknown: $1" >&2; exit 2 ;; esac; done
[ -d "$TARGET" ] || { echo "no such dir: $TARGET" >&2; exit 2; }
say() { printf '[init-project] %s\n' "$*"; }

# .gitignore
gi="$TARGET/.gitignore"; touch "$gi"
if grep -q '\.claude/worktrees/' "$gi"; then say ".gitignore: 이미 있음"
else printf '\n' >> "$gi"; cat "$HERE/gitignore.snippet" >> "$gi"; say ".gitignore: snippet 추가"; fi

# work_log
if [ -f "$TARGET/CLAUDE.md" ] && grep -q "work_log.md" "$TARGET/CLAUDE.md" && [ ! -f "$TARGET/claudedocs/work_log.md" ]; then
  say "work_log.md: CLAUDE.md 가 이미 다른 위치를 지정함 — 생성 생략"
elif [ -f "$TARGET/claudedocs/work_log.md" ]; then say "work_log.md: 이미 있음"
else mkdir -p "$TARGET/claudedocs"; cp "$HERE/claudedocs/work_log.md" "$TARGET/claudedocs/work_log.md"; say "work_log.md: 생성"; fi

# rules
for r in "${RULES[@]:-}"; do
  [ -n "$r" ] || continue
  src="$HERE/../rules/$r.md"; [ -f "$src" ] || { say "rule 없음: $r"; continue; }
  mkdir -p "$TARGET/.claude/rules"
  if [ -f "$TARGET/.claude/rules/$r.md" ]; then say "rules/$r.md: 이미 있음"; else cp "$src" "$TARGET/.claude/rules/$r.md"; say "rules/$r.md: 복사"; fi
done

# CLAUDE.md section
cm="$TARGET/CLAUDE.md"; touch "$cm"
if grep -q '^## Claude Code 운용' "$cm"; then say "CLAUDE.md: 운용 절 이미 있음"
else printf '\n---\n\n' >> "$cm"; cat "$HERE/CLAUDE-section.md" >> "$cm"; say "CLAUDE.md: 운용 절 추가 — <...> 자리표시자를 채워라"; fi
say "완료"
