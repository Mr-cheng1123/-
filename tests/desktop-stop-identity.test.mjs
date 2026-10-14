import test from 'node:test';
import assert from 'node:assert/strict';
import {localAppUrl, verifyStopIdentity} from '../scripts/stop-app.mjs';

const pid = 31416;
const token = '12345678-1234-1234-1234-123456789abc';
const nodePath = 'D:\\codex\\runtime\\node.exe';
const createdAt = 1_791_497_120_000;

function fixture() {
  return {
    pid,
    expectedToken: token,
    host: 'fixture-host',
    nodePath,
    health: {ok: true, app: 'funding-arb', pid, mode: 'live'},
    lock: {version: 1, app: 'funding-arb', pid, token, hostname: 'fixture-host', createdAt},
    processInfo: {
      ProcessId: pid,
      ExecutablePath: nodePath,
      CommandLine: `"${nodePath}" --import tsx src/server.ts`,
      createdAt: createdAt - 2_000,
    },
    listeners: [{LocalAddress: '127.0.0.1', OwningProcess: pid}],
  };
}

function refuses(change) {
  const input = fixture();
  change(input);
  assert.throws(() => verifyStopIdentity(input));
}

test('verified live owner returns the same PID and generation without changing its evidence', () => {
  const input = fixture();
  const before = structuredClone(input);
  assert.deepEqual(verifyStopIdentity(input), {pid, mode: 'live', token, createdAt});
  assert.deepEqual(input, before);
});

test('paper owner and Windows executable casing use the same ownership checks', () => {
  const input = fixture();
  input.health.mode = 'paper';
  input.processInfo.ExecutablePath = nodePath.toUpperCase();
  input.processInfo.CommandLine = `"${nodePath}" --import "tsx" "src\\server.ts"`;
  assert.deepEqual(verifyStopIdentity(input), {pid, mode: 'paper', token, createdAt});
});

test('an old control window cannot close a replacement generation with the same PID', () => {
  refuses(input => { input.expectedToken = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'; });
});

test('invalid requested PIDs and mismatched HTTP or native PIDs are refused', () => {
  for (const value of [0, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    refuses(input => { input.pid = value; });
  }
  refuses(input => { input.health.pid++; });
  refuses(input => { input.lock.pid++; });
  refuses(input => { input.processInfo.ProcessId++; });
});

test('an unsuccessful, foreign, or unknown-mode HTTP service is refused', () => {
  refuses(input => { input.health.ok = false; });
  refuses(input => { input.health.ok = 'true'; });
  refuses(input => { input.health.app = 'another-service'; });
  refuses(input => { input.health.mode = 'unknown'; });
});

test('foreign host, app, schema, and malformed generation records are refused', () => {
  refuses(input => { input.lock.hostname = 'another-host'; });
  refuses(input => { input.lock.app = 'another-service'; });
  refuses(input => { input.lock.version = 2; });
  for (const value of [undefined, '', 'broken', 123]) {
    refuses(input => { input.lock.token = value; });
  }
  for (const value of [undefined, NaN, Infinity, '1791497120000']) {
    refuses(input => { input.lock.createdAt = value; });
  }
});

test('a reused PID or process too old to have created this lock is refused', () => {
  refuses(input => { input.processInfo.createdAt = createdAt + 2_001; });
  refuses(input => { input.processInfo.createdAt = createdAt - 120_001; });
  for (const value of [undefined, NaN, Infinity, '1791497118000']) {
    refuses(input => { input.processInfo.createdAt = value; });
  }
});

test('a different or inaccessible executable is refused even when the command line looks right', () => {
  refuses(input => { input.processInfo.ExecutablePath = 'D:\\other-app\\node.exe'; });
  refuses(input => { input.processInfo.ExecutablePath = null; });
});

test('the actual tsx import and server entry must be complete command-line arguments', () => {
  for (const line of [
    `"${nodePath}" --import other-loader src/server.ts`,
    `"${nodePath}" --import tsx-other src/server.ts`,
    `"${nodePath}" --import tsx other/server.ts`,
    `"${nodePath}" --import tsx src/server.ts.backup`,
    `"${nodePath}" --import tsx othersrc/server.ts`,
    `"${nodePath}" -e "console.log('src/server.ts')"`,
    '',
  ]) {
    refuses(input => { input.processInfo.CommandLine = line; });
  }
});

test('missing, foreign, nonlocal, or multiple listeners cannot establish port ownership', () => {
  refuses(input => { input.listeners = []; });
  refuses(input => { input.listeners[0].OwningProcess++; });
  for (const address of ['0.0.0.0', '::', '::1', '192.0.2.1']) {
    refuses(input => { input.listeners[0].LocalAddress = address; });
  }
  refuses(input => {
    input.listeners.push({LocalAddress: '127.0.0.1', OwningProcess: pid});
  });
});

test('local application URL accepts only an explicit loopback HTTP port and root path', () => {
  for (const port of [1024, 8787, 8788, 65535]) {
    assert.equal(localAppUrl(`http://127.0.0.1:${port}`).href, `http://127.0.0.1:${port}/`);
  }
});

test('foreign, privileged, credentialed, or nonroot URLs never become stop targets', () => {
  for (const value of [
    undefined,
    '',
    'not a URL',
    'https://127.0.0.1:8787/',
    'http://localhost:8787/',
    'http://[::1]:8787/',
    'http://0.0.0.0:8787/',
    'http://192.0.2.1:8787/',
    'http://example.com:8787/',
    'http://127.0.0.1/',
    'http://127.0.0.1:1023/',
    'http://127.0.0.1:65536/',
    'http://user:password@127.0.0.1:8787/',
    'http://127.0.0.1:8787/api/health',
    'http://127.0.0.1:8787/?pid=123',
    'http://127.0.0.1:8787/#control',
  ]) {
    assert.throws(() => localAppUrl(value), undefined, String(value));
  }
});
