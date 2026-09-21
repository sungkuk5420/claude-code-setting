#!/usr/bin/env node
// code-reviewer 에이전트 전용 PreToolUse(Bash) — 조회 명령만 허용한다(agents/code-reviewer.md frontmatter 에서 등록).
//   리뷰어는 fail-closed 가 맞다: stdin 파싱 실패·예외·판단 불가는 전부 deny. (다른 훅의 fail-open 과 반대.)
//   판정 순서: ① 세그먼트(&&, ||, ;, |)마다 쓰기 징후가 있으면 deny — 리다이렉션(> >>; /dev/null·2>&1 제외), tee,
//   sed -i, find -delete/-exec, rm/mv/cp/touch/mkdir/chmod, --output=. ② git 은 조회 서브커맨드만(`git -C <dir>` 허용,
//   branch 는 목록 옵션만, worktree 는 list 만). ③ 그 외는 허용 목록의 명령으로 시작해야 한다.
//   `git worktree add` 는 허용하지 않는다 — 다른 리비전은 `git show <sha>:<path>` 로 본다.
//   막히면 리뷰어는 그 명령을 보고서의 권고로 적는다(deny 사유에 명시해 우회 재시도를 끊는다).
'use strict';
const fs = require('node:fs');

const ALLOWED_HEAD = /^(cd|pwd|cat|head|tail|wc|ls|find|grep|rg|awk|sort|uniq|echo|printf|tr|cut|diff|jq|sed\s+-n\b|(npx\s+)?(jest|vitest|tsc|eslint)\b|node_modules[\\/]\.bin[\\/](jest|vitest|tsc|eslint)\b|npm\s+(test|run)\b|npm\s+--prefix\s+\S+\s+(test|run)\b)/;
const GIT_READ_SUBS = new Set(['diff', 'log', 'show', 'status', 'blame', 'rev-parse', 'merge-base', 'rev-list', 'ls-files', 'ls-tree', 'grep', 'diff-tree', 'cat-file', 'describe', 'shortlog', 'for-each-ref', 'name-rev', 'reflog', 'count-objects']);
const BRANCH_READ_WITH_ARG = new Set(['--contains', '--no-contains', '--merged', '--no-merged', '--points-at', '--sort', '--format']);
const WRITE_FLAGS = /^(--fix|--fix-dry-run|--fix-type|-u|--update|--update-snapshot|--updateSnapshot|--write|-w|--watch|--coverage|--emit|--outDir|--out-dir|--outFile)$/;
const BRANCH_WRITE_OPTS = /^(-d|-D|-m|-M|-c|-C|-f|--delete|--move|--copy|--force|--set-upstream-to|-u|--unset-upstream|--edit-description|--track|--no-track)$/;

function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `code-reviewer 는 조회 명령만 실행한다: ${reason}. 이 명령이 필요하면 보고서의 권고에 적어라(재시도하지 말 것).`,
    },
  }));
  process.exit(0);
}

// 셸 세그먼트 분리 — 따옴표 안의 && ; | 는 구분자로 보지 않는다(python -c "a; b" 같은 인라인 코드가 쪼개지지 않게).
function splitSegments(cmd) {
  const out = []; let cur = ''; let q = null;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (q) { cur += ch; if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
    if (ch === '&' && cmd[i + 1] === '&') { out.push(cur); cur = ''; i++; continue; }
    if (ch === '|') { out.push(cur); cur = ''; if (cmd[i + 1] === '|') i++; continue; }
    if (ch === ';' || ch === '\n') { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map(s => s.trim()).filter(Boolean);
}

function tokenize(seg) {
  const out = []; let cur = ''; let q = null;
  for (const ch of seg) {
    if (q) { if (ch === q) q = null; else cur += ch; continue; }
    if (ch === '"' || ch === "'") { q = ch; continue; }
    if (/\s/.test(ch)) { if (cur) { out.push(cur); cur = ''; } continue; }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

function checkSegment(seg) {
  const s = seg.trim();
  if (!s) return null;
  // ① 쓰기 징후
  if (/&>|>\|/.test(s)) return '리다이렉션 쓰기(&> 또는 >|)';
  const redirects = s.match(/(?:^|[^>&|])(\d?>>?)\s*(\S+)/g) || [];
  for (const r of redirects) {
    const target = r.replace(/^.*?(\d?>>?)\s*/, '');
    if (target === '/dev/null' || target === '&1' || target === '&2' || target === 'NUL') continue;
    return `리다이렉션 쓰기(${r.trim()})`;
  }
  const t = tokenize(s);
  if (t.length === 0) return null;
  if (/^(tee|rm|mv|cp|touch|mkdir|chmod|chown|truncate|dd|install)$/.test(t[0])) return `쓰기 명령 ${t[0]}`;
  if (t[0] === 'sed' && t.some(a => /^-i/.test(a) || a === '--in-place')) return 'sed -i';
  if (t[0] === 'find' && t.some(a => a === '-delete' || a === '-exec' || a === '-execdir' || a === '-ok')) return 'find -delete/-exec';
  if (t.some(a => /^--output(=|$)/.test(a) || a === '-o' && t[0] === 'git')) return '--output 쓰기';
  const wf = t.find(a => WRITE_FLAGS.test(a));
  if (wf) return `쓰기·감시 플래그 ${wf}`;
  if (/^(npx\s+)?tsc\b/.test(s) || /\.bin[\\/]tsc\b/.test(s)) { if (!t.includes('--noEmit')) return 'tsc 는 --noEmit 필수(emit 은 쓰기)'; }
  if (/^npm\b/.test(s)) { const ri = t.indexOf('run'); if (ri >= 0 && !/^(test|typecheck|type-check|lint|check)(:[\w-]+)?$/.test(t[ri + 1] || '')) return 'npm run 은 test/typecheck/lint 스크립트만'; }
  // ② git
  if (t[0] === 'git') {
    let i = 1;
    while (i < t.length && t[i].startsWith('-')) { if (t[i] === '-C') i += 2; else i += 1; }
    const sub = t[i]; const args = t.slice(i + 1);
    if (!sub) return 'git 서브커맨드 없음';
    if (GIT_READ_SUBS.has(sub)) return null;
    if (sub === 'branch') {
      for (let k = 0; k < args.length; k++) {
        const a = args[k];
        if (a.startsWith('-')) { if (BRANCH_WRITE_OPTS.test(a)) return 'git branch 변경'; continue; }
        const prev = args[k - 1] || '';
        if (!BRANCH_READ_WITH_ARG.has(prev) && !BRANCH_READ_WITH_ARG.has(prev.split('=')[0])) return 'git branch 변경(위치 인자)';
      }
      return null;
    }
    if (sub === 'worktree') return args[0] === 'list' ? null : `git worktree ${args[0] || ''}`;
    if (sub === 'stash') return (args[0] === 'list' || args[0] === 'show') ? null : `git stash ${args[0] || ''}`;
    if (sub === 'tag') return (args.some(a => a === '-l' || a === '--list') && !args.some(a => /^(-d|-a|-s|-f|-m|--delete|--annotate|--sign|--force)$/.test(a))) ? null : 'git tag 변경';
    if (sub === 'remote') return (args.length === 0 || args[0] === '-v' || args[0] === 'show' || args[0] === 'get-url') ? null : `git remote ${args[0] || ''}`;
    if (sub === 'config') return (args.some(a => /^(--get|--get-all|--get-regexp|--list|-l)$/.test(a)) && !args.some(a => /^(--unset|--unset-all|--add|--replace-all|--edit|-e|--rename-section|--remove-section)$/.test(a))) ? null : 'git config 변경';
    return `git ${sub}`;
  }
  // ③ 허용 목록
  if (ALLOWED_HEAD.test(s)) return null;
  return `허용 목록에 없는 명령(${t[0]})`;
}

try {
  const input = JSON.parse(fs.readFileSync(0, 'utf8').replace(/^﻿/, ''));
  const cmd = String((input.tool_input && input.tool_input.command) || '');
  if (!cmd.trim()) deny('빈 명령');
  if (/\$\(|`|\$\{/.test(cmd)) deny('명령 치환·변수 확장');
  for (const seg of splitSegments(cmd)) {
    const why = checkSegment(seg);
    if (why) deny(why);
  }
  process.exit(0);
} catch (e) {
  deny(`판단 불가(${(e && e.message) || 'parse error'})`);
}
