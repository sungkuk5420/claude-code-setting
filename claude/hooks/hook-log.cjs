#!/usr/bin/env node
// 공용 모듈(훅 아님) — 훅들의 "결정 지점"만 JSONL 로 남긴다.
//   파일: ${CLAUDE_CONFIG_DIR:-~/.claude}/logs/hooks.jsonl  (5MB 넘으면 hooks.jsonl.1 로 1회 회전)
//   끄기: CLAUDE_HOOK_LOG=off
//   기록 범위: git-guard 의 deny/ask/fail-open, lint 의 exit 2 반환·조용한 통과, verify 의 block/상한/예산초과/통과,
//             session-end 정리. 매 PreToolUse 통과는 기록하지 않는다(Bash 호출량이 많아 로그가 빨리 찬다).
//   fail-open·조용한 통과·상한 도달은 transcript 에도 남지 않으므로 이 파일이 유일한 사후 추적 수단이다.
//   cmd 필드는 URL 자격증명·token=… 을 마스킹하고 500자로 자른다. 모든 예외는 삼킨다(로그가 훅을 깨지 않게).
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MAX_BYTES = 5 * 1024 * 1024;

function mask(s) {
  return String(s)
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g, '$1***:***@')
    .replace(/((?:token|password|passwd|secret|api[_-]?key|authorization)[=: ]+)[^\s&"']+/gi, '$1***')
    .slice(0, 500);
}

function log(event, data) {
  try {
    if ((process.env.CLAUDE_HOOK_LOG || '').toLowerCase() === 'off') return;
    const dir = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'logs');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'hooks.jsonl');
    try { if (fs.statSync(file).size > MAX_BYTES) fs.renameSync(file, file + '.1'); } catch { /* 첫 기록 */ }
    const rec = { ts: new Date().toISOString(), event, ...(data || {}) };
    if (rec.cmd !== undefined) rec.cmd = mask(rec.cmd);
    if (rec.error !== undefined) rec.error = String(rec.error).slice(0, 300);
    fs.appendFileSync(file, JSON.stringify(rec) + '\n');
  } catch { /* 로그 실패는 무시 */ }
}

module.exports = log;
module.exports.mask = mask;
