#!/usr/bin/env node
// Stop — Claude 가 턴을 끝내려 할 때, "이 세션이 편집한 코드 트리"만 typecheck + test 한다.
// 검증 대상은 record-edited-tree.cjs 가 세션별로 기록한 트리 집합(메인·워크트리 무관, 세션 스코프).
// 명령은 각 트리 package.json 스크립트에서 도구명을 파싱해 node_modules/.bin 을 직접 실행한다.
// 하나라도 실패하면 {"decision":"block"} 으로 완료를 막고 실패 로그를 되돌린다.
//
//  건너뛰는 경우: 이 세션이 코드 파일을 편집하지 않음 / node_modules 없음 / 변경이 이미 커밋·되돌려짐 /
//                 typecheck·test 도구가 로컬에 없음. (테스트 파일 삭제 검사만은 커밋 여부와 무관하게 돈다.)
//
//  시도 상한: MAX_BLOCKS(기본 3, CLAUDE_VERIFY_MAX_BLOCKS). Claude Code 자체의 Stop 연속 블록 상한은
//    8회(진전 없을 때, CLAUDE_CODE_STOP_HOOK_BLOCK_CAP)이고 이 훅은 그 안쪽에서 끝난다. stop_hook_active 를
//    보고 조기 exit 하지 않는다 — 카운터가 탈출구다. 상한에 닿으면 마지막 1회를 "더 수정하지 말고 미해결
//    실패를 최종 보고에 명시하고 종료하라" 로 block 하고 st.final 을 남긴다. 다음 Stop 은 무조건 통과(상태파일
//    삭제) → 총 계속 횟수 = MAX_BLOCKS + 1, 사이클 재진입 없음.
//
//  시간 예산: CLAUDE_VERIFY_BUDGET_SEC(기본 540, settings.json 의 Stop timeout 600 보다 작아야 한다).
//    명령별 timeout 은 남은 명령 수로 공평 분할. 예산이 모자라 검증하지 못한 트리는 통과가 아니라 실패 항목으로
//    남기고(무언 통과 없음) st.unverified 에 기록해 다음 Stop 이 그 트리부터 돈다. 통과한 단계는 변경 해시와
//    함께 st.passed[tree] 에 기억해 재실행하지 않으므로 여러 Stop 에 걸쳐 "이어서 검증" 된다.
//    시간 초과만 남고 실제 실패가 없으면 1회만 block 하고, 그 다음부터는 stderr 경고와 함께 통과시킨다.
//
//  테스트 삭제 감지(PW-8): record-edited-tree.cjs 가 트리를 처음 기록할 때 저장한 HEAD 테스트 파일 스냅샷
//    (st.trees[tree].tests) 중 워킹트리에서 사라진 것을 본다. 같은 basename 이 트리 안 어디든(추적+미추적) 있으면
//    이동으로 간주하고, 사라진 수 > 새로 생긴 수(순감소)일 때만 차단한다. 커밋 여부와 무관하게 잡힌다.
//    탈출구: <tree>/.claude/verify/test-removal.md 가 마지막 편집 이후 갱신돼 있으면 통과(사용자 확인을 받은 삭제.
//    최종 보고에 사유 포함). 한계: 스냅샷 이전에 이미 삭제된 것은 못 보고, jest/vitest 기본 testMatch 밖의
//    커스텀 패턴(tests/*.ts 등)은 "테스트 0개" 로 판정될 수 있다.
//  --passWithNoTests 는 스냅샷 기준 테스트가 0개인 트리에만 붙인다(러너의 "no tests found" 오탐 방지).
//
//  화면검증(UI) 게이트: 이 세션이 화면 파일(.vue/.tsx/.css/… 또는 components/views/pages 아래 코드)을
//  편집했으면, 마지막 UI 편집 이후에 만들어진 증거가 <tree>/.claude/verify/ 에 있어야 완료를 허용한다.
//    증거 = 스크린샷 등 아무 파일 (예: node ~/.claude/scripts/cdp.cjs shot <tree>/.claude/verify/after.png)
//    또는 <tree>/.claude/verify/ui-skip.md (화면 확인이 불가능한 사유를 적는다. 최종 보고에 그 사유를 포함할 것)
//
//  상태파일: os.tmpdir()/claude-verify-gate-<session_id>.json  (Windows %TEMP%). 통과·final 시 삭제.
//    updated 가 24시간 넘은 상태는 blocks 카운터를 리셋한다(크래시 뒤 --resume 로 옛 카운터가 되살아나는 것 방지).
//  감사 로그: hook-log.cjs → ~/.claude/logs/hooks.jsonl (block / 상한 / 예산초과 / 통과 각 1줄).
//  환경변수: CLAUDE_VERIFY_GATE=off 전체 비활성, CLAUDE_UI_GATE=off 화면검증만 비활성,
//            CLAUDE_VERIFY_MAX_BLOCKS, CLAUDE_VERIFY_BUDGET_SEC, CLAUDE_HOOK_LOG=off.
'use strict';
const { execSync, execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const log = require('./hook-log.cjs');

const CODE_EXTS = ['.ts', '.tsx', '.vue', '.js', '.jsx', '.cjs', '.mjs', '.svelte'];
const TEST_RE = /(\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)__tests__\/.*\.[cm]?[jt]sx?$)/;
const MAX_BLOCKS = Math.max(1, parseInt(process.env.CLAUDE_VERIFY_MAX_BLOCKS || '3', 10) || 3);
const BUDGET_SEC = Math.max(30, Number(process.env.CLAUDE_VERIFY_BUDGET_SEC) || 540);
const DEADLINE = Date.now() + BUDGET_SEC * 1000;
const STATE_PREFIX = 'claude-verify-gate-';
const STALE_MS = 24 * 60 * 60 * 1000;

if ((process.env.CLAUDE_VERIFY_GATE || '').toLowerCase() === 'off') process.exit(0);

let input = {};
try { input = JSON.parse(fs.readFileSync(0, 'utf8').replace(/^﻿/, '')); } catch { /* 입력 없어도 진행 */ }

const sid = String(input.session_id || 'nosession').replace(/[^\w.-]/g, '_');
const stateFile = path.join(os.tmpdir(), `${STATE_PREFIX}${sid}.json`);

let st;
try { st = JSON.parse(fs.readFileSync(stateFile, 'utf8')); }
catch { process.exit(0); } // 이 세션의 코드 편집 기록 없음 → 게이트 미발동

if (st.final) { // 직전 Stop 에서 상한 도달 → 이번엔 무조건 통과, 사이클 종료
  try { fs.unlinkSync(stateFile); } catch {}
  log('verify', { session_id: sid, result: 'final-pass', blocks: st.blocks });
  process.exit(0);
}
if (st.updated && Date.now() - st.updated > STALE_MS) { st.blocks = 0; st.timeoutBlocks = 0; }

const treeKeys = Object.keys(st.trees || {});
const uiTrees = Object.keys(st.ui || {});
if (treeKeys.length === 0 && uiTrees.length === 0) process.exit(0);

const CONFIG_DIR = (process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')).replace(/\\/g, '/');
const treeInfo = t => (st.trees[t] && typeof st.trees[t] === 'object') ? st.trees[t] : {};

function git(dir, args, timeout = 4000) {
  try {
    return execFileSync('git', ['-C', dir, ...args], {
      stdio: ['ignore', 'pipe', 'ignore'], timeout, windowsHide: true, maxBuffer: 64 * 1024 * 1024,
    }).toString();
  } catch { return null; }
}

// 마지막 UI 편집(또는 삭제) 이후에 갱신된 파일이 <tree>/.claude/verify/ 에 있는가.
function evidenceSince(tree, since, only) {
  const dir = path.join(tree, '.claude', 'verify');
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return { ok: false, dir }; }
  for (const n of names) {
    if (n === '.gitignore') continue;
    if (only && n !== only) continue;
    let m; try { m = fs.statSync(path.join(dir, n)); } catch { continue; }
    if (!m.isFile()) continue;
    if (m.mtimeMs >= since - 2000) return { ok: true, dir, file: n, skip: n === 'ui-skip.md' };
  }
  return { ok: false, dir };
}

function statusLines(dir) {
  // -uall: 미추적 디렉토리를 "?? src/" 로 접지 않고 파일 단위로 보여준다(확장자 필터가 동작하도록).
  const out = git(dir, ['status', '--porcelain', '-uall']);
  return out === null ? null : out.split('\n').filter(Boolean);
}
function changedCodeFiles(dir) {
  const lines = statusLines(dir) || [];
  return lines.map(l => l.slice(3).trim()).filter(Boolean).filter(f => CODE_EXTS.some(e => f.endsWith(e)));
}
// 워킹트리 변경 상태의 지문: diff HEAD + status(미추적 파일은 mtime·size 포함). 같으면 이미 통과한 검증을 재사용.
function changeHash(dir) {
  const diff = git(dir, ['diff', 'HEAD']);
  const lines = statusLines(dir);
  if (diff === null || lines === null) return null;
  const extra = lines.filter(l => l.startsWith('??')).map(l => {
    try { const m = fs.statSync(path.join(dir, l.slice(3).trim())); return `${l}|${m.size}|${Math.floor(m.mtimeMs)}`; } catch { return l; }
  });
  return crypto.createHash('sha1').update(diff + '\0' + lines.join('\n') + '\0' + extra.join('\n')).digest('hex');
}
function headTests(dir) {
  const out = git(dir, ['ls-tree', '-r', '--name-only', 'HEAD']);
  if (out === null) return null;
  return out.split('\n').map(s => s.trim()).filter(f => f && CODE_EXTS.some(e => f.endsWith(e)) && TEST_RE.test(f));
}
// 스냅샷 대비 사라진 테스트 파일. 이동(같은 basename 존재)·순증가는 차단하지 않는다.
function testRemoval(tree, info) {
  const snap = Array.isArray(info.tests) ? info.tests : (headTests(tree) || []);
  const missing = snap.filter(f => !fs.existsSync(path.join(tree, f)));
  if (missing.length === 0) return { snap, gone: [] };
  const ls = git(tree, ['ls-files', '--cached', '--others', '--exclude-standard']) || '';
  const current = ls.split('\n').map(s => s.trim()).filter(f => f && CODE_EXTS.some(e => f.endsWith(e)) && TEST_RE.test(f));
  const names = new Set(current.map(f => path.basename(f)));
  const gone = missing.filter(f => !names.has(path.basename(f)));
  const added = current.filter(f => !snap.includes(f));
  if (gone.length === 0 || gone.length <= added.length) return { snap, gone: [] };
  const waiver = evidenceSince(tree, info.last || 0, 'test-removal.md');
  return { snap, gone, waived: waiver.ok };
}
function readPkg(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch { return null; }
}
function binPath(tree, tool) {
  const base = path.join(tree, 'node_modules', '.bin', tool);
  const cands = process.platform === 'win32' ? [base + '.cmd', base + '.CMD', base] : [base];
  for (const c of cands) { if (fs.existsSync(c)) return c; }
  return null;
}
// "vue-tsc --noEmit && eslint ." → { tool: 'vue-tsc', args: '--noEmit' }
function scriptParts(scriptStr) {
  const seg = String(scriptStr).split(/&&|\|\|/)[0].trim();
  const toks = seg.split(/\s+/);
  return { tool: toks[0], args: toks.slice(1).join(' ') };
}
let remainingCmds = 1;
function fairTimeout() {
  return Math.max(5000, Math.min(5 * 60 * 1000, Math.floor((DEADLINE - Date.now()) / Math.max(1, remainingCmds))));
}
function run(dir, cmd) {
  const timeout = fairTimeout();
  const t0 = Date.now();
  try {
    // maxBuffer: 기본 1MB 를 넘으면 ENOBUFS 로 죽어 통과한 스위트를 실패로 보고한다 → 넉넉히.
    // killSignal SIGKILL + windowsHide: Windows 에서 .cmd 셸만 죽고 node 자식(vitest 등)이 남는 것을 줄인다.
    execSync(cmd, { cwd: dir, stdio: 'pipe', timeout, killSignal: 'SIGKILL', windowsHide: true, maxBuffer: 256 * 1024 * 1024 });
    return { ok: true, out: '', ms: Date.now() - t0 };
  } catch (e) {
    const timedOut = !!(e && (e.signal || e.code === 'ETIMEDOUT'));
    let out = `${(e && e.stdout) || ''}\n${(e && e.stderr) || ''}`.trim().slice(-4000);
    if (timedOut) out = `[시간 초과 ${Math.round(timeout / 1000)}s] 훅 안에서 끝나지 않았다. 직접 실행해 결과를 보고하라.\n${out}`;
    return { ok: false, out, timedOut, ms: Date.now() - t0 };
  }
}

const failures = []; // { kind: 'fail'|'timeout'|'deleted'|'ui', text }
const notes = [];
const unverified = [];
const ran = [];

// 검증 순서: 지난 Stop 에서 예산 부족으로 못 본 트리부터.
const prevUnverified = Array.isArray(st.unverified) ? st.unverified : [];
const trees = [...prevUnverified.filter(t => treeKeys.includes(t)), ...treeKeys.filter(t => !prevUnverified.includes(t))];

// 1) 테스트 삭제 검사 — clean-skip 보다 앞(커밋된 트리도 검사)
const snapByTree = {};
for (const tree of trees) {
  const info = treeInfo(tree);
  const r = testRemoval(tree, info);
  snapByTree[tree] = r.snap;
  if (r.gone.length === 0) continue;
  const list = r.gone.slice(0, 20).map(f => '  - ' + f).join('\n');
  if (r.waived) { notes.push(`${path.basename(tree)}: 테스트 파일 삭제가 test-removal.md 로 승인됨 — 최종 보고에 사유 포함:\n${list}`); continue; }
  failures.push({ kind: 'deleted', text:
    `### ${path.basename(tree)} — 테스트 파일 삭제 감지(세션 시작 시점 스냅샷 대비)\n${list}\n` +
    `테스트를 삭제해 게이트를 통과하는 것은 금지다(PW-8). git restore 로 복구하거나, 사용자 지시에 의한 삭제면 ` +
    `${tree.replace(/\\/g, '/')}/.claude/verify/test-removal.md 에 사유를 적고 최종 보고에 포함하라. 이동이면 같은 파일명으로 트리 안에 두어라.` });
}

// 2) typecheck / test — 후보를 먼저 추려 남은 명령 수로 시간 예산을 나눈다.
st.passed = st.passed || {};
const cands = [];
for (const tree of trees) {
  if (!fs.existsSync(path.join(tree, 'node_modules'))) continue;
  if (changedCodeFiles(tree).length === 0) { delete st.passed[tree]; continue; }
  const hash = changeHash(tree);
  const p = st.passed[tree];
  if (p && hash && p.hash === hash && p.tc && p.test) continue; // 같은 상태를 이미 통과
  cands.push({ tree, hash, prev: (p && hash && p.hash === hash) ? p : null });
}
remainingCmds = cands.length * 2;

for (const c of cands) {
  const { tree, hash } = c;
  const label = path.basename(tree);
  const pkg = readPkg(tree);
  const scripts = (pkg && pkg.scripts) || {};
  const passed = { hash, tc: !!(c.prev && c.prev.tc), test: !!(c.prev && c.prev.test) };

  if (DEADLINE - Date.now() < 5000) { unverified.push(tree); remainingCmds -= 2; continue; }

  // typecheck: 스크립트 있으면 그 도구, 없으면 tsc --noEmit. 로컬 바이너리 없으면 스킵.
  if (!passed.tc) {
    let tcTool = 'tsc', tcArgs = '--noEmit';
    const tcScript = scripts.typecheck || scripts['type-check'] || scripts.tsc;
    if (tcScript) { const p = scriptParts(tcScript); tcTool = p.tool; tcArgs = p.args || ''; }
    const tcBin = binPath(tree, tcTool) || (tcScript ? null : binPath(tree, 'tsc'));
    if (tcBin) {
      const tc = run(tree, `"${tcBin}" ${tcArgs}`.trim());
      ran.push({ tree: label, cmd: tcTool, ms: tc.ms, ok: tc.ok });
      if (!tc.ok) {
        failures.push({ kind: tc.timedOut ? 'timeout' : 'fail', text: `### ${label} — typecheck(${tcTool}) 실패\n${tc.out}` });
        st.passed[tree] = passed; remainingCmds -= 2; continue;
      }
    }
    passed.tc = true;
  }
  remainingCmds -= 1;

  // test: 스크립트 있을 때만. 도구 바이너리 없으면 스킵.
  if (!passed.test) {
    if (DEADLINE - Date.now() < 5000) { unverified.push(tree); st.passed[tree] = passed; remainingCmds -= 1; continue; }
    if (scripts.test) {
      const p = scriptParts(scripts.test);
      const tBin = binPath(tree, p.tool);
      if (tBin) {
        const snapEmpty = (snapByTree[tree] || []).length === 0;
        const noTestsFlag = snapEmpty && (p.tool === 'jest' || p.tool === 'vitest') ? ' --passWithNoTests' : '';
        const t = run(tree, `"${tBin}" ${p.args}${noTestsFlag}`.trim());
        ran.push({ tree: label, cmd: p.tool, ms: t.ms, ok: t.ok });
        if (!t.ok) {
          failures.push({ kind: t.timedOut ? 'timeout' : 'fail', text: `### ${label} — test(${p.tool}) 실패\n${t.out}` });
          st.passed[tree] = passed; remainingCmds -= 1; continue;
        }
      }
    }
    passed.test = true;
  }
  remainingCmds -= 1;
  st.passed[tree] = passed;
}

if (unverified.length) {
  const verifiedNow = cands.map(c => c.tree).filter(t => !unverified.includes(t)).map(t => path.basename(t));
  failures.push({ kind: 'timeout', text:
    `### 검증 예산(${BUDGET_SEC}s) 초과 — 미검증 트리: ${unverified.map(t => path.basename(t)).join(', ')}\n` +
    `이번 Stop 에서 통과한 트리: ${verifiedNow.join(', ') || '(없음)'}. 다음 Stop 은 남은 트리만 이어서 돈다. ` +
    `직접 실행해 출력을 보고해도 된다(typecheck → test 순, PW-8).` });
}
st.unverified = unverified;

// 3) 화면검증 게이트
if ((process.env.CLAUDE_UI_GATE || '').toLowerCase() !== 'off') {
  for (const tree of uiTrees) {
    const info = st.ui[tree] || {};
    const files = Object.keys(info.files || {});
    if (files.length === 0) continue;
    const ev = evidenceSince(tree, info.last || 0);
    if (ev.ok) continue;
    try { fs.mkdirSync(ev.dir, { recursive: true }); fs.writeFileSync(path.join(ev.dir, '.gitignore'), '*\n'); } catch {}
    const evDir = ev.dir.replace(/\\/g, '/');
    failures.push({ kind: 'ui', text:
      `### ${path.basename(tree)} — 화면검증 증거 없음\n` +
      `이 세션에서 화면 파일을 편집했다:\n${files.slice(0, 12).map(f => '  - ' + f).join('\n')}${files.length > 12 ? `\n  … 외 ${files.length - 12}개` : ''}\n` +
      `프론트 변경은 화면을 띄워 확인해야 완료다(전역 규칙 PW-6). 마지막 UI 편집 이후의 증거를 ${evDir}/ 에 남겨라:\n` +
      `  1) 앱을 띄운다 (run 스킬 / 프로젝트 dev·verify 스크립트 / node ${CONFIG_DIR}/scripts/cdp.cjs launch <url>)\n` +
      `  2) node ${CONFIG_DIR}/scripts/cdp.cjs shot "${evDir}/after.png"  (필요하면 eval·text·sample·console 도)\n` +
      `  3) 스크린샷을 Read 로 열어 실제로 보고, 본 것을 최종 보고에 적는다.\n` +
      `화면 확인이 정말 불가능하면(앱 실행 불가·헤드리스 환경) "${evDir}/ui-skip.md" 에 사유를 쓰고 최종 보고에 그 사유를 포함하라.` });
  }
}

const titles = failures.map(f => f.text.split('\n')[0]);
if (failures.length === 0) {
  try { fs.unlinkSync(stateFile); } catch {}
  log('verify', { session_id: sid, result: 'pass', trees: treeKeys.map(t => path.basename(t)), ran, notes: notes.length });
  if (notes.length) process.stderr.write(`[verify] ${notes.join('\n')}\n`);
  process.exit(0);
}

const now = Date.now();
st.updated = now;

// 시간 초과만 남았고 실제 실패가 없으면: 1회만 block, 그 다음은 경고와 함께 통과(느린 스위트가 3라운드를 먹지 않게).
if (failures.every(f => f.kind === 'timeout')) {
  st.timeoutBlocks = (st.timeoutBlocks || 0) + 1;
  if (st.timeoutBlocks > 1) {
    try { fs.unlinkSync(stateFile); } catch {} // 사이클 종료 — 같은 느린 스위트를 매 턴 다시 돌리지 않는다
    process.stderr.write(`[verify] 시간 초과로 미검증 트리가 남아 있다(통과시킴). 직접 typecheck/test 를 돌려 보고하라:\n${titles.join('\n')}\n`);
    log('verify', { session_id: sid, result: 'timeout-pass', timeoutBlocks: st.timeoutBlocks, failures: titles, ran });
    process.exit(0);
  }
}

st.blocks = (st.blocks || 0) + 1;
const body = failures.map(f => f.text).join('\n\n') + (notes.length ? `\n\n---\n${notes.join('\n')}` : '');

if (st.blocks >= MAX_BLOCKS) { // 상한 도달 → 마지막 1회: 미해결 실패를 보고에 쓰게 하고, 다음 Stop 은 무조건 통과
  st.final = true;
  try { fs.writeFileSync(stateFile, JSON.stringify(st)); } catch {}
  const reason =
    `검증 게이트 시도 상한(${MAX_BLOCKS}회) 도달 — 더 수정하지 말고 아래 미해결 실패를 최종 보고에 그대로 명시한 뒤 종료하라(PW-8). ` +
    `다음 응답은 게이트가 통과시킨다.\n\n` + body.slice(0, 6000);
  log('verify', { session_id: sid, result: 'cap', blocks: st.blocks, failures: titles, ran });
  process.stdout.write(JSON.stringify({
    decision: 'block', reason,
    systemMessage: `검증 게이트 상한(${MAX_BLOCKS}회) 도달 — 게이트가 포기했다. 최종 보고의 미해결 실패를 사람이 확인하라.`,
  }));
  process.exit(0);
}
try { fs.writeFileSync(stateFile, JSON.stringify(st)); } catch {}

const reason =
  `검증 실패(시도 ${st.blocks}/${MAX_BLOCKS}) — 완료할 수 없다. ` +
  `아래를 수정하고 다시 검증하라(테스트 스킵·주석처리·삭제 금지):\n\n` + body;

log('verify', { session_id: sid, result: 'block', blocks: st.blocks, failures: titles, ran });
process.stdout.write(JSON.stringify({ decision: 'block', reason }));
process.exit(0);
