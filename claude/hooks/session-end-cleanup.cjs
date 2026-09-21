#!/usr/bin/env node
// SessionEnd(logout|prompt_input_exit|other) — 이 세션의 검증 게이트 상태파일을 지우고 7일 넘은 잔재를 청소한다.
//   - matcher 에서 clear/resume 는 뺀다: /clear 는 같은 세션의 UI 게이트가 날아가지 않게, resume(일시 중단)는
//     이어갈 때 게이트가 살아 있게 하기 위해서다.
//   - SessionEnd 는 정상 종료에만 발화한다(프로세스 kill·크래시·VS Code 강제 종료에는 돌지 않는다).
//     그래서 7일 mtime 스윕이 주된 방어이고, verify-on-stop 은 24시간 넘은 상태의 blocks 카운터를 스스로 리셋한다.
//   - 상태파일이 남는 경우는 크래시만이 아니라 verify-on-stop 이 block 한 뒤 사용자가 세션을 그냥 끝낸 경우도 포함.
//   - %TEMP% 항목이 수천 개일 수 있으므로 readdir 후 접두어가 맞는 이름만 stat 한다. settings 의 timeout 은 5초.
//   - 지운 상태파일의 요약(trees/blocks)을 감사 로그에 남긴다(CLAUDE_HOOK_LOG=off 로 끔).
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const log = require('./hook-log.cjs');

const STATE_PREFIX = 'claude-verify-gate-';
const SWEEP_MS = 7 * 24 * 60 * 60 * 1000;

let input = {};
try { input = JSON.parse(fs.readFileSync(0, 'utf8').replace(/^﻿/, '')); } catch { /* 입력 없어도 진행 */ }
const sid = String(input.session_id || 'nosession').replace(/[^\w.-]/g, '_');
const tmp = os.tmpdir();

try {
  const f = path.join(tmp, `${STATE_PREFIX}${sid}.json`);
  let summary = null;
  try {
    const st = JSON.parse(fs.readFileSync(f, 'utf8'));
    summary = { trees: Object.keys(st.trees || {}).map(t => path.basename(t)), ui: Object.keys(st.ui || {}).length, blocks: st.blocks || 0, final: !!st.final };
  } catch { /* 없음 */ }
  if (summary) {
    try { fs.unlinkSync(f); } catch {}
    log('session-end', { session_id: sid, reason: input.reason, ...summary });
  }
} catch { /* fail-open */ }

// 7일 넘은 잔재 청소(다른 세션의 것 포함)
try {
  const now = Date.now();
  let swept = 0;
  for (const n of fs.readdirSync(tmp)) {
    if (!n.startsWith(STATE_PREFIX) || !n.endsWith('.json')) continue;
    try {
      const p = path.join(tmp, n);
      if (now - fs.statSync(p).mtimeMs > SWEEP_MS) { fs.unlinkSync(p); swept++; }
    } catch { /* 개별 실패 무시 */ }
  }
  if (swept) log('session-end', { session_id: sid, swept });
} catch { /* fail-open */ }
process.exit(0);
