#!/usr/bin/env node
// PostToolUse(Edit|Write|MultiEdit|NotebookEdit) — 두 가지를 한다.
//  (1) 편집한 코드 파일이 속한 package.json 트리를 "이 세션이 건드린 트리"로 기록한다.
//      Stop 훅(verify-on-stop.cjs)은 이 집합만 검증하므로 무관한 WIP 워크트리가 완료를 막지 않는다.
//      트리를 처음 기록할 때 HEAD 의 테스트 파일 목록과 HEAD sha 를 스냅샷으로 남긴다(테스트 삭제 감지·
//      --passWithNoTests 부착 여부의 기준). 상태파일의 다른 키(passed/final/blocks 등)는 병합해 보존한다.
//  (2) 그 트리에 eslint 가 로컬 설치돼 있으면 편집 파일만 빠르게 --fix 한다.
//      남는 lint 에러(exit 1)는 stderr + exit 2 로 Claude 에게 되돌린다. 설정 크래시(exit 2 등)는 조용히 통과
//      (감사 로그에만 남긴다).
// 파일에서 위로 올라가 package.json 을 찾으므로 메인 체크아웃·워크트리 모두 자동 대응.
// npx/npm 을 거치지 않고 node_modules/.bin 을 직접 호출한다(nvm 환경에서의 가짜 실패 회피).
// 상태파일: os.tmpdir()/claude-verify-gate-<session_id>.json. 감사 로그: hook-log.cjs(CLAUDE_HOOK_LOG=off).
'use strict';
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const log = require('./hook-log.cjs');

const CODE_EXTS = ['.ts', '.tsx', '.vue', '.js', '.jsx', '.cjs', '.mjs', '.svelte'];
// 화면에 영향을 주는 파일 — Stop 게이트의 화면검증(UI) 요구 대상. 스타일·마크업도 포함.
const UI_EXTS = ['.vue', '.tsx', '.jsx', '.svelte', '.html', '.css', '.scss', '.sass', '.less', '.styl'];
const UI_DIRS = /\/(components?|views?|pages?|layouts?|screens?|widgets?|ui)\//i;
const TEST_RE = /(\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)__tests__\/.*\.[cm]?[jt]sx?$)/;
const STATE_PREFIX = 'claude-verify-gate-';

let raw = '';
try { raw = fs.readFileSync(0, 'utf8').replace(/^﻿/, ''); } catch { process.exit(0); }
let input; try { input = JSON.parse(raw); } catch { process.exit(0); }

const filePath = ((input.tool_input && (input.tool_input.file_path || input.tool_input.notebook_path)) || '').replace(/\\/g, '/');
if (!filePath) process.exit(0);
const isCode = CODE_EXTS.some(e => filePath.endsWith(e));
const isUi = UI_EXTS.some(e => filePath.endsWith(e)) || (isCode && UI_DIRS.test(filePath));
if (!isCode && !isUi) process.exit(0);
if (!fs.existsSync(filePath)) process.exit(0);

function findPkgRoot(p) {
  let dir = path.dirname(p);
  for (let i = 0; i < 30; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}
function binPath(tree, tool) {
  const base = path.join(tree, 'node_modules', '.bin', tool);
  const cands = process.platform === 'win32' ? [base + '.cmd', base + '.CMD', base] : [base];
  for (const c of cands) { if (fs.existsSync(c)) return c; }
  return null;
}
function git(dir, args) {
  try {
    return execFileSync('git', ['-C', dir, ...args], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 4000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 }).toString();
  } catch { return null; }
}

const root = findPkgRoot(filePath);
if (!root) process.exit(0); // package.json 트리 밖(문서·설정 등) → 게이트 대상 아님

// (1) 세션 스코프 기록
const sid = String(input.session_id || 'nosession').replace(/[^\w.-]/g, '_');
try {
  const f = path.join(os.tmpdir(), `${STATE_PREFIX}${sid}.json`);
  let st = { trees: {}, ui: {}, blocks: 0 };
  try { st = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { /* 첫 기록 */ }
  st.trees = st.trees || {};
  st.ui = st.ui || {};
  const now = Date.now();
  if (isCode) {
    let info = st.trees[root];
    if (!info || typeof info !== 'object') { // 최초 기록 → 그 트리의 첫 편집 시점 스냅샷(그 전에 지운 테스트는 못 본다)
      const ls = git(root, ['ls-tree', '-r', '--name-only', 'HEAD']);
      const tests = ls === null ? null : ls.split('\n').map(s => s.trim()).filter(x => x && CODE_EXTS.some(e => x.endsWith(e)) && TEST_RE.test(x));
      const base = (git(root, ['rev-parse', 'HEAD']) || '').trim() || null;
      info = { since: now, last: now, base, tests };
    }
    info.last = now;
    st.trees[root] = info;
  }
  if (isUi) { st.ui[root] = st.ui[root] || { files: {}, last: 0 }; st.ui[root].files[filePath] = now; st.ui[root].last = now; }
  st.updated = now;
  fs.writeFileSync(f, JSON.stringify(st));
} catch { /* 기록 실패는 치명적 아님 */ }

// (2) eslint --fix (편집 파일만, 코드 파일만)
if (!isCode) process.exit(0);
const eslintBin = binPath(root, 'eslint');
if (!eslintBin) process.exit(0);
try {
  execFileSync(eslintBin, ['--fix', filePath], { cwd: root, stdio: 'pipe', timeout: 45000, shell: process.platform === 'win32', windowsHide: true });
  process.exit(0);
} catch (e) {
  if (e && e.status === 1) {
    const out = `${e.stdout || ''}${e.stderr || ''}`.trim().slice(-3000);
    log('lint', { session_id: sid, root, file: filePath, status: 1 });
    process.stderr.write(`[lint] 편집 파일에 lint 에러가 남아 있다 (${root}):\n${out}\n→ 위 오류를 수정한 뒤 계속하라.\n`);
    process.exit(2);
  }
  log('lint', { session_id: sid, root, file: filePath, status: e && e.status, signal: e && e.signal, silent: true }); // 설정 크래시·타임아웃: 조용히 통과
  process.exit(0);
}
