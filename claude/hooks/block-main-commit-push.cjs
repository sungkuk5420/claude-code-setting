#!/usr/bin/env node
// PreToolUse(Bash|PowerShell) — 보호 브랜치(main / master / DEPLOY-*)로의 커밋·푸시를 하드 차단한다.
//
//  차단 규칙
//   1. `git push` 인자가 보호 브랜치를 명시하면 차단
//        origin main / HEAD:main / refs/heads/master / --delete main / -u origin DEPLOY-260612 ...
//   2. `git commit` / refspec 없는 `git push` 는 대상 저장소의 현재 브랜치가 보호 브랜치면 차단
//        대상 저장소 = `git -C <dir>` > 같은 명령 앞쪽의 `cd <dir>` > 훅 입력의 cwd
//   3. 같은 명령 안에서 `git switch main && git commit ...` 처럼 먼저 보호 브랜치로 옮겨도 차단
//   4. 셸 세그먼트에 `git` 토큰이 없는데 문자열 안에 `git push`/`git commit` 이 있으면 차단
//        (node -e "execSync('git push …')", python -c, bash -c, powershell -Command 등 인라인 코드 우회.
//         토큰 단위로만 git 을 보므로 따옴표 안은 이 규칙이 잡는다. 첫 토큰이 코드 실행기(node/python/bash/
//         powershell/ruby/perl/eval …)인 세그먼트에만 적용해 grep/echo/cat 의 오탐을 피한다.)
//
//  브랜치 확인 실패: git 이 타임아웃(3초)·스폰 실패(ENOENT)로 답을 못 준 경우만 `ask` 로 사람에게 넘긴다.
//   "not a git repository"·경로 없음(exit 128)은 지금처럼 통과 — cd 파싱이 빗나가도 워크플로를 막지 않는다.
//   ask 는 대화형 세션에서만 사람 확인이고 헤드리스(-p)에서는 거부로 떨어지므로 reason 에 재시도 방법을 적는다.
//
//  설정(환경변수)
//   CLAUDE_GIT_GUARD=off                     훅 전체 비활성(개인 설정 레포처럼 main 직접 커밋이 정상인 곳)
//   CLAUDE_PROTECTED_BRANCHES=main,master,DEPLOY-*   보호 브랜치 목록(쉼표 구분, 끝의 * 는 접두어 매칭)
//   CLAUDE_HOOK_LOG=off                      감사 로그(~/.claude/logs/hooks.jsonl) 끄기
//
//  파싱·실행 오류는 전부 fail-open(허용) — 워크플로를 훅 버그로 막지 않는다. 단 fail-open 은 로그에 남긴다.
'use strict';
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const log = require('./hook-log.cjs');

const DEFAULT_PROTECTED = 'main,master,DEPLOY-*';
const GIT_TIMEOUT_MS = 3000;

function protectedMatchers() {
  const raw = process.env.CLAUDE_PROTECTED_BRANCHES || DEFAULT_PROTECTED;
  return raw.split(',').map(s => s.trim()).filter(Boolean).map(p =>
    p.endsWith('*') ? (b => b.startsWith(p.slice(0, -1))) : (b => b === p));
}
const MATCHERS = protectedMatchers();
const isProtected = b => !!b && MATCHERS.some(m => m(b));

// MSYS(/c/..., /mnt/c/...) 경로를 Windows 드라이브 경로로, 홈 표기(~)를 실제 홈으로.
function normalizePath(p) {
  if (!p) return p;
  let s = p.replace(/^["']|["']$/g, '');
  if (s === '~' || s.startsWith('~/')) s = path.join(process.env.HOME || process.env.USERPROFILE || '', s.slice(1));
  const msys = s.match(/^\/(?:mnt\/)?([a-zA-Z])\/(.*)$/);
  if (msys && process.platform === 'win32') s = `${msys[1].toUpperCase()}:/${msys[2]}`;
  return s;
}

// { branch, kind } — kind: null(정상) | 'timeout' | 'spawn' | 'norepo'. 디렉토리별 캐시(훅 timeout 15초 안에 끝나도록).
const branchCache = new Map();
function currentBranch(dir) {
  if (branchCache.has(dir)) return branchCache.get(dir);
  let r;
  try {
    const b = execFileSync('git', ['-C', dir, 'branch', '--show-current'], { stdio: ['ignore', 'pipe', 'pipe'], timeout: GIT_TIMEOUT_MS, windowsHide: true })
      .toString().trim();
    r = { branch: b, kind: null };
  } catch (e) {
    if (e && (e.signal || e.code === 'ETIMEDOUT')) r = { branch: null, kind: 'timeout' };
    else if (e && e.code === 'ENOENT') r = { branch: null, kind: 'spawn' };
    else r = { branch: null, kind: 'norepo' }; // exit 128: not a git repository / cannot change to … → 통과
  }
  branchCache.set(dir, r);
  return r;
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

// 셸 토큰화(따옴표 보존). 완벽할 필요는 없다 — 애매하면 fail-open.
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

function branchFromRefspec(spec) {
  // HEAD:main, feat:refs/heads/main, main, refs/heads/main, +main:main, :main(delete)
  let s = spec.replace(/^\+/, '');
  if (s.includes(':')) s = s.split(':').pop();
  return s.replace(/^refs\/heads\//, '');
}

let CMD = '';
let SID = '';
function emit(decision, reason) {
  log('git-guard', { session_id: SID, decision, reason, cmd: CMD });
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision,
      permissionDecisionReason: reason,
    },
  }));
  process.exit(0);
}
const deny = reason => emit('deny', reason);
const ask = reason => emit('ask', reason);

// 브랜치를 알아야 하는데 git 이 답을 못 준 경우 → ask
function requireBranch(dir, what) {
  const r = currentBranch(dir);
  if (r.kind === 'timeout' || r.kind === 'spawn') {
    ask(`보호 브랜치 여부를 확인하지 못했다(git ${r.kind === 'timeout' ? '타임아웃' : '실행 실패'}, ${dir}). ` +
        `\`git -C "${dir}" branch --show-current\` 로 현재 브랜치를 확인한 뒤 ${what} 을(를) 다시 실행하라.`);
  }
  return r.branch;
}

try {
  if ((process.env.CLAUDE_GIT_GUARD || '').toLowerCase() === 'off') process.exit(0);

  let input = {};
  try { input = JSON.parse(fs.readFileSync(0, 'utf8').replace(/^﻿/, '')); } catch { process.exit(0); }
  const cmd = String((input.tool_input && input.tool_input.command) || '');
  CMD = cmd;
  SID = String(input.session_id || '');
  if (!/\bgit\b/.test(cmd) || !/\b(commit|push)\b/.test(cmd)) process.exit(0);

  let cwd = normalizePath(input.cwd || process.cwd());
  let pendingBranch = null; // 같은 명령 안에서 switch/checkout 으로 옮긴 브랜치

  const segments = splitSegments(cmd);
  for (const seg of segments) {
    const t = tokenize(seg);
    if (t.length === 0) continue;

    if ((t[0] === 'cd' || t[0] === 'Set-Location' || t[0] === 'pushd') && t[1]) {
      cwd = path.isAbsolute(normalizePath(t[1])) ? normalizePath(t[1]) : path.resolve(cwd, normalizePath(t[1]));
      continue;
    }
    const gi = t.indexOf('git');
    if (gi < 0) {
      // 규칙 4: 토큰에는 git 이 없는데 세그먼트 원문(따옴표 안)에 git push/commit 이 있다 → 인라인 코드 우회
      const EXECUTOR = /^(node|nodejs|deno|bun|python[0-9.]*|py|ruby|perl|php|bash|sh|zsh|dash|powershell|pwsh|eval|exec)$/i;
      if (EXECUTOR.test(t[0]) && /\bgit\s+(push|commit)\b/.test(seg)) {
        deny('인라인 코드·문자열 안의 git push/commit 은 허용하지 않는다. 셸 명령으로 직접 실행하라.');
      }
      continue;
    }

    let dir = cwd;
    let i = gi + 1;
    const opts = [];
    while (i < t.length && t[i].startsWith('-')) {
      if (t[i] === '-C' && t[i + 1]) { const d = normalizePath(t[i + 1]); dir = path.isAbsolute(d) ? d : path.resolve(cwd, d); i += 2; continue; }
      opts.push(t[i]); i += 1;
    }
    const sub = t[i];
    const args = t.slice(i + 1);
    if (!sub) continue;

    if (sub === 'switch' || sub === 'checkout') {
      const ci = args.findIndex(a => a === '-c' || a === '-C' || a === '-b' || a === '-B');
      if (ci >= 0 && args[ci + 1]) { pendingBranch = args[ci + 1]; continue; } // 새 브랜치 생성·이동
      const target = args.filter(a => !a.startsWith('-')).pop();
      if (target) pendingBranch = target;
      continue;
    }

    if (sub === 'commit') {
      const b = pendingBranch || requireBranch(dir, 'commit');
      if (isProtected(b)) {
        deny(`보호 브랜치 '${b}' 에는 커밋할 수 없다 (${dir}). 먼저 'git switch -c <feat/...>' 로 서브 브랜치를 만들어라. ` +
             `이 레포에서 main 직접 커밋이 정상이라면 CLAUDE_GIT_GUARD=off 로 훅을 끄고 실행하라.`);
      }
      continue;
    }

    if (sub === 'push') {
      const positional = [];
      for (let k = 0; k < args.length; k++) {
        const a = args[k];
        if (a === '-o' || a === '--push-option' || a === '--receive-pack' || a === '--repo') { k += 1; continue; }
        if (a.startsWith('-')) {
          if (a === '-d' || a === '--delete') { positional.push('__DELETE__'); }
          continue;
        }
        positional.push(a);
      }
      const isDelete = positional.includes('__DELETE__');
      const refspecs = positional.filter(p => p !== '__DELETE__').slice(1); // 첫 positional 은 remote
      const explicit = refspecs.map(branchFromRefspec).filter(Boolean);
      const hit = explicit.find(isProtected);
      if (hit) {
        deny(`보호 브랜치 '${hit}' 로의 push${isDelete ? '(삭제)' : ''} 는 금지다. 서브 브랜치로 push 하고 MR/PR 을 올려라.`);
      }
      if (explicit.length === 0) {
        const b = pendingBranch || requireBranch(dir, 'push');
        if (isProtected(b)) {
          deny(`현재 브랜치 '${b}' 는 보호 브랜치라 push 할 수 없다 (${dir}). 서브 브랜치에서 작업하라.`);
        }
      }
    }
  }
  process.exit(0);
} catch (e) {
  log('git-guard', { session_id: SID, decision: 'fail-open', error: e && (e.stack || e.message || e), cmd: CMD });
  process.exit(0); // fail-open
}
