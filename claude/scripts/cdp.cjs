#!/usr/bin/env node
/**
 * 화면검증 헬퍼 (범용 CDP 클라이언트) — 실행 중인 Chrome/Edge/Electron 창에 붙어 스크린샷·상태·콘솔을 읽는다.
 * 의존성 없음 (Node 22+ 의 전역 WebSocket 사용).
 *
 * 앱이 원격 디버깅 포트로 떠 있어야 한다:
 *   - 웹앱:      node ~/.claude/scripts/cdp.cjs launch http://localhost:5173   (Chrome/Edge 를 포트 열고 띄움)
 *   - Electron:  메인 프로세스에서 app.commandLine.appendSwitch('remote-debugging-port', '9222')
 *                또는 프로젝트의 verify 실행 스크립트 (예: no1 sourcing 의 npm run verify:serve)
 *
 * 명령:
 *   launch <url>                    Chrome/Edge 를 --remote-debugging-port 로 새 프로필에 띄운다
 *   targets                         붙을 수 있는 페이지 목록 (url)
 *   shot [파일경로]                  스크린샷 PNG (기본 ./cdp-shot.png)
 *   eval "<js식>"                    페이지에서 JS 평가 (await 가능, 값 출력)
 *   text "<css선택자>"               일치 요소들의 textContent
 *   console [밀리초]                 콘솔 로그·예외를 지정 시간 동안 수집 (기본 5000)
 *   sample "<js식>" [간격ms] [횟수]   식을 반복 평가해 시계열 출력 (기본 100ms × 30회). 순간 증상 잡기용
 *
 * 타겟 선택: --url <부분문자열> 또는 CDP_URL_HINT. 없으면 about:blank·devtools 를 뺀 첫 페이지.
 * 환경변수: CDP_PORT(9222) CDP_TIMEOUT_MS(20000) CDP_URL_HINT CDP_BROWSER(브라우저 실행파일 경로)
 *
 * 실측 함정 (no1 sourcing 에서 배운 것):
 *   - 최소화·가려진 창은 컴포지터가 프레임을 안 만들어 captureScreenshot 이 영원히 안 돌아온다.
 *     → 찍기 전에 visibilityState 를 확인하고 사유를 말한다. 화면 없이 볼 땐 eval/text 를 쓴다.
 *   - VS Code 확장 호스트가 ELECTRON_RUN_AS_NODE=1 을 자식에 물려줘 Electron 이 node 로 뜬다.
 *     → Electron 을 띄우는 스크립트에서 그 변수를 지운다.
 *   - 모든 요청에 시한을 둔다. "영원히 멈춤"은 원인을 못 알려준다.
 */
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const PORT = process.env.CDP_PORT || '9222';
const TIMEOUT_MS = Number(process.env.CDP_TIMEOUT_MS || 20000);

const argv = process.argv.slice(2);
let urlHint = process.env.CDP_URL_HINT || '';
const hintIdx = argv.indexOf('--url');
if (hintIdx >= 0) { urlHint = argv[hintIdx + 1] || ''; argv.splice(hintIdx, 2); }
const [command, ...rest] = argv;

function fail(message) { console.error(`[cdp] ${message}`); process.exit(1); }

function WS() {
  if (typeof WebSocket === 'function') return WebSocket;
  try { return require('ws'); } catch { fail('WebSocket 이 없습니다. Node 22+ 또는 `npm i -g ws` 가 필요합니다.'); }
}

async function listPageTargets() {
  let targets;
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
    targets = await res.json();
  } catch (error) {
    fail(`CDP 포트 ${PORT} 에 붙지 못했습니다: ${error.message}\n` +
         `앱이 --remote-debugging-port=${PORT} 로 떠 있습니까? 웹앱이면: node cdp.cjs launch <url>`);
  }
  return targets.filter(t => t.type === 'page');
}

function pickTarget(pages) {
  const candidates = pages.filter(t => t.url && t.url !== 'about:blank' && !t.url.startsWith('devtools://'));
  if (candidates.length === 0) fail('붙을 수 있는 페이지가 없습니다. 앱이 떠 있습니까?');
  const main = urlHint ? candidates.find(t => t.url.includes(urlHint)) : candidates[0];
  if (!main) fail(`힌트 '${urlHint}' 와 일치하는 페이지가 없습니다:\n${candidates.map(t => '  - ' + t.url).join('\n')}`);
  return main;
}

function openSession(target) {
  const Sock = WS();
  const ws = new Sock(target.webSocketDebuggerUrl);
  const pending = new Map();
  const listeners = [];
  let nextId = 0;

  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`창에 붙지 못했습니다 (${TIMEOUT_MS}ms)`)), TIMEOUT_MS);
    ws.addEventListener('open', () => { clearTimeout(timer); resolve(); });
    ws.addEventListener('error', e => { clearTimeout(timer); reject(new Error(e.message || 'websocket error')); });
  });
  ws.addEventListener('message', ev => {
    const message = JSON.parse(String(ev.data));
    if (message.id !== undefined && pending.has(message.id)) {
      const { resolve, reject, timer } = pending.get(message.id);
      pending.delete(message.id); clearTimeout(timer);
      if (message.error) reject(new Error(JSON.stringify(message.error))); else resolve(message.result);
      return;
    }
    for (const l of listeners) l(message);
  });
  return {
    ready,
    send(method, params) {
      const id = (nextId += 1);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} 응답 없음 (${TIMEOUT_MS}ms) — 창이 멈췄거나 가려져 있습니다.`)); }, TIMEOUT_MS);
        pending.set(id, { resolve, reject, timer });
        ws.send(JSON.stringify({ id, method, params: params || {} }));
      });
    },
    on(l) { listeners.push(l); },
    close() { try { ws.close(); } catch {} },
  };
}

async function evaluate(session, expression) {
  const result = await session.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) {
    const d = result.exceptionDetails;
    throw new Error(`평가 실패: ${(d.exception && (d.exception.description || d.exception.value)) || d.text}`);
  }
  return result.result.value;
}

function findBrowser() {
  if (process.env.CDP_BROWSER) return process.env.CDP_BROWSER;
  const pf = [process.env['ProgramFiles'], process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA].filter(Boolean);
  const cands = [];
  for (const base of pf) {
    cands.push(path.join(base, 'Google/Chrome/Application/chrome.exe'));
    cands.push(path.join(base, 'Microsoft/Edge/Application/msedge.exe'));
  }
  cands.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
             '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
             '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/microsoft-edge');
  return cands.find(c => fs.existsSync(c)) || null;
}

function fmt(v) { return typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v); }

async function main() {
  if (!command) fail('명령이 필요합니다 — launch | targets | shot | eval | text | console | sample');

  if (command === 'launch') {
    const url = rest[0]; if (!url) fail('띄울 URL 이 필요합니다.');
    const bin = findBrowser(); if (!bin) fail('Chrome/Edge 를 찾지 못했습니다. CDP_BROWSER 로 실행파일 경로를 지정하십시오.');
    const profile = path.join(os.tmpdir(), `claude-cdp-profile-${PORT}`);
    const child = spawn(bin, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--new-window', url],
      { detached: true, stdio: 'ignore' });
    child.unref();
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 250));
      try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) { console.log(`launched ${path.basename(bin)} pid=${child.pid} port=${PORT} url=${url}`); return; } } catch {}
    }
    fail('브라우저가 떴지만 CDP 포트가 열리지 않았습니다. 이미 같은 프로필의 브라우저가 떠 있으면 닫고 다시 시도하십시오.');
  }

  const pages = await listPageTargets();
  if (command === 'targets') { for (const t of pages) console.log(t.url); return; }

  const target = pickTarget(pages);
  const session = openSession(target);
  await session.ready;
  try {
    if (command === 'shot') {
      const out = path.resolve(rest[0] || 'cdp-shot.png');
      fs.mkdirSync(path.dirname(out), { recursive: true });
      await session.send('Page.enable');
      await session.send('Page.bringToFront');
      const visible = await evaluate(session, 'document.visibilityState');
      if (visible !== 'visible') fail(`창이 화면에 없어 스크린샷을 찍을 수 없습니다 (visibilityState=${visible}). 창을 앞으로 세우거나 eval/text 로 확인하십시오.`);
      const result = await session.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(out, Buffer.from(result.data, 'base64'));
      console.log(out);
      return;
    }
    if (command === 'eval') {
      if (!rest[0]) fail('평가할 식이 필요합니다.');
      console.log(fmt(await evaluate(session, rest.join(' '))));
      return;
    }
    if (command === 'text') {
      if (!rest[0]) fail('선택자가 필요합니다.');
      const texts = await evaluate(session, `Array.from(document.querySelectorAll(${JSON.stringify(rest[0])})).map(n => (n.textContent || '').trim())`);
      if (!Array.isArray(texts) || texts.length === 0) console.log('(일치하는 요소 없음)'); else texts.forEach(t => console.log(t));
      return;
    }
    if (command === 'sample') {
      if (!rest[0]) fail('평가할 식이 필요합니다.');
      const interval = Number(rest[1] || 100), count = Number(rest[2] || 30);
      const t0 = Date.now();
      for (let i = 0; i < count; i++) {
        let v; try { v = fmt(await evaluate(session, rest[0])); } catch (e) { v = `ERR ${e.message}`; }
        console.log(`${String(Date.now() - t0).padStart(6)}ms  ${v}`);
        await new Promise(r => setTimeout(r, interval));
      }
      return;
    }
    if (command === 'console') {
      const ms = Number(rest[0] || 5000);
      await session.send('Runtime.enable'); await session.send('Log.enable');
      session.on(m => {
        if (m.method === 'Runtime.consoleAPICalled') console.log(`[${m.params.type}] ${(m.params.args || []).map(a => a.value !== undefined ? String(a.value) : a.description || a.type).join(' ')}`);
        else if (m.method === 'Runtime.exceptionThrown') { const d = m.params.exceptionDetails; console.log(`[pageerror] ${(d.exception && d.exception.description) || d.text}`); }
        else if (m.method === 'Log.entryAdded') console.log(`[${m.params.entry.level}] ${m.params.entry.text}`);
      });
      console.error(`[cdp] ${ms}ms 동안 콘솔 수집 중… (${target.url})`);
      await new Promise(r => setTimeout(r, ms));
      return;
    }
    fail(`알 수 없는 명령: ${command}`);
  } finally { session.close(); }
}

main().catch(e => fail(e && e.stack ? e.stack : String(e)));
