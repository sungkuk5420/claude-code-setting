#!/usr/bin/env node
// SessionStart(compact|resume) — 컴팩션·재개 뒤에 사라지는 "지금 어디서 무엇을 하고 있었나" 를 재주입한다.
//   compact: 브랜치 / git status --porcelain(30줄) / 최근 커밋 5개 / 검증 게이트 상태 / .claude/loop-contract.md /
//            claudedocs/work_log.md 의 '커밋 미실행·보류·미완' 줄(1,500바이트까지)
//   resume : 검증 게이트 상태 + loop-contract.md 만(시스템 프롬프트의 gitStatus 와 중복 방지)
//   입력의 cwd 를 쓴다(${CLAUDE_PROJECT_DIR} 는 시작 디렉토리에 고정되지만 cwd 는 워크트리를 따라간다).
//   게이트 상태파일은 통과·상한 도달 시 삭제되므로 "없음" 이 정상 상태다.
//   git 호출당 timeout 1.5초, 전체 3초 예산(settings timeout 15초 안쪽). 모든 예외는 항목 생략 후 계속(fail-open).
//   끄기: CLAUDE_REINJECT=off
'use strict';
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

if ((process.env.CLAUDE_REINJECT || '').toLowerCase() === 'off') process.exit(0);

let input = {};
try { input = JSON.parse(fs.readFileSync(0, 'utf8').replace(/^﻿/, '')); } catch { /* 입력 없어도 진행 */ }
const cwd = String(input.cwd || process.cwd());
const source = String(input.source || 'compact');
const sid = String(input.session_id || 'nosession').replace(/[^\w.-]/g, '_');
const DEADLINE = Date.now() + 3000;
const over = () => Date.now() > DEADLINE;

function git(args) {
  if (over()) return null;
  try {
    return execFileSync('git', ['-C', cwd, ...args], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 1500, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }).toString().trim();
  } catch { return null; }
}
function head(text, n) {
  const lines = text.split('\n');
  return lines.slice(0, n).join('\n') + (lines.length > n ? `\n… 외 ${lines.length - n}줄` : '');
}
function readCapped(file, cap) {
  try { const s = fs.readFileSync(file, 'utf8'); return s.length > cap ? s.slice(0, cap) + '\n…(잘림)' : s; } catch { return null; }
}

const parts = [];
parts.push(source === 'resume'
  ? '[재개 후 재주입] 아래는 이 세션의 검증 게이트·루프 계약 상태다. 자율 루프 중이었다면 루프 계약(PW-7)을 이 상태 위에서 이어간다.'
  : '[컴팩션 후 재주입] 아래는 현재 작업 상태다. 자율 루프 중이었다면 루프 계약(PW-7)을 이 상태 위에서 이어간다. 요약을 믿지 말고 이 상태를 기준으로 삼는다.');

if (source !== 'resume') {
  const branch = git(['branch', '--show-current']);
  if (branch !== null) parts.push(`브랜치: ${branch || '(detached HEAD)'}`);
  const status = git(['status', '--porcelain']);
  if (status !== null) parts.push(status ? `미커밋 변경(git status --porcelain):\n${head(status, 30)}` : '미커밋 변경: 없음');
  const logOut = git(['log', '--oneline', '-5']);
  if (logOut) parts.push(`최근 커밋:\n${logOut}`);
}

// 검증 게이트 상태 (verify-on-stop.cjs 의 상태파일)
let gateFound = false;
try {
  const st = JSON.parse(fs.readFileSync(path.join(os.tmpdir(), `claude-verify-gate-${sid}.json`), 'utf8'));
  gateFound = true;
  const trees = Object.keys(st.trees || {});
  const ui = Object.keys(st.ui || {}).map(t => `${path.basename(t)}(${Object.keys((st.ui[t] || {}).files || {}).length}개 화면 파일)`);
  const bits = [];
  if (trees.length) bits.push(`검증 대상 트리: ${trees.join(', ')}`);
  if (ui.length) bits.push(`화면검증 대기: ${ui.join(', ')}`);
  if (st.blocks) bits.push(`Stop 게이트 차단 ${st.blocks}회${st.final ? ' (상한 도달 — 다음 Stop 은 통과)' : ''}`);
  if (Array.isArray(st.unverified) && st.unverified.length) bits.push(`예산 초과로 미검증: ${st.unverified.map(t => path.basename(t)).join(', ')}`);
  parts.push(bits.length ? `검증 게이트(verify-on-stop): ${bits.join(' / ')}` : '검증 게이트: 미검증 편집 없음');
} catch { parts.push('검증 게이트: 미검증 편집 없음(상태파일 없음 — 통과했거나 아직 코드 편집 없음)'); }

// 루프 계약
const contract = readCapped(path.join(cwd, '.claude', 'loop-contract.md'), 2000);
if (contract) parts.push(`루프 계약(.claude/loop-contract.md):\n${contract.trim()}`);

// 작업 로그의 미완 항목 (compact 만)
if (source !== 'resume') {
  const wl = readCapped(path.join(cwd, 'claudedocs', 'work_log.md'), 512 * 1024);
  if (wl) {
    const hits = wl.split('\n').filter(l => /커밋 미실행|보류|미완/.test(l));
    if (hits.length) {
      let acc = ''; let n = 0;
      for (const l of hits.slice(-40)) { if (Buffer.byteLength(acc + l + '\n') > 1500) break; acc += l + '\n'; n++; }
      parts.push(`work_log.md 의 미커밋·보류·미완 줄(최근 ${n}개):\n${acc.trim()}${hits.length > n ? '\n(더 있음 — PW-9 에 따라 work_log.md 를 Grep 하라)' : ''}`);
    }
  }
}

// resume 인데 재주입할 상태가 없으면 아무것도 넣지 않는다(빈 머리말로 컨텍스트를 낭비하지 않는다).
if (source === 'resume' && !gateFound && !contract) process.exit(0);

process.stdout.write(JSON.stringify({
  hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: parts.join('\n\n') },
}));
process.exit(0);
