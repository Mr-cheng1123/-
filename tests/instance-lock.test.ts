import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import { acquireInstanceLock, InstanceLockError, processStatus, type InstanceLockRecord } from '../src/core/instance-lock.js';

function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), 'funding-instance-'));
  return { file: path.join(directory, 'paper.lock'), cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}
const record = (pid = process.pid): InstanceLockRecord => ({ version: 1, app: 'funding-arb', pid, token: randomUUID(), hostname: hostname(), createdAt: Date.now() });

test('records the owner PID and token, and normal release removes only that record', async () => {
  const f = fixture(); try {
    const lock = await acquireInstanceLock(f.file);
    const saved = JSON.parse(readFileSync(f.file, 'utf8'));
    assert.equal(saved.pid, process.pid); assert.equal(saved.token, lock.record.token);
    await lock.release(); await lock.release(); assert.equal(existsSync(f.file), false);
    const replacement = await acquireInstanceLock(f.file); await replacement.release();
  } finally { f.cleanup(); }
});

test('confirmed dead owners recover automatically, while live and unknown owners remain untouched', async () => {
  const f = fixture(); try {
    const previous = record(); writeFileSync(f.file, JSON.stringify(previous));
    await assert.rejects(acquireInstanceLock(f.file), (error: unknown) => error instanceof InstanceLockError && error.code === 'active');
    await assert.rejects(acquireInstanceLock(f.file, { probeProcess: () => 'unknown' }), (error: unknown) => error instanceof InstanceLockError && error.code === 'unknown');
    assert.equal(JSON.parse(readFileSync(f.file, 'utf8')).token, previous.token);
    const lock = await acquireInstanceLock(f.file, { probeProcess: () => 'dead' });
    assert.notEqual(lock.record.token, previous.token); await lock.release();
  } finally { f.cleanup(); }
});

test('a lock written before the machine booted is stale even if its PID was reused by another program', async () => {
  const f = fixture(); try {
    const previous = { ...record(), createdAt: Date.now() - 3_600_000 };
    writeFileSync(f.file, JSON.stringify(previous));
    // Boot happened after the record was written: the "alive" PID is an unrelated process.
    const lock = await acquireInstanceLock(f.file, { probeProcess: () => 'alive', bootTimeMs: Date.now() - 60_000 });
    assert.notEqual(lock.record.token, previous.token); await lock.release();
    // A recent record with a live PID is still refused.
    writeFileSync(f.file, JSON.stringify(record()));
    await assert.rejects(acquireInstanceLock(f.file, { probeProcess: () => 'alive', bootTimeMs: Date.now() - 3_600_000 }), (error: unknown) => error instanceof InstanceLockError && error.code === 'active');
  } finally { f.cleanup(); }
});

test('legacy empty or malformed locks cannot be assumed stale', async () => {
  const f = fixture(); try {
    for (const content of ['', '{broken', JSON.stringify({ pid: 123 })]) {
      writeFileSync(f.file, content);
      await assert.rejects(acquireInstanceLock(f.file, { probeProcess: () => 'dead' }), (error: unknown) => error instanceof InstanceLockError && error.code === 'unknown');
      assert.equal(readFileSync(f.file, 'utf8'), content);
    }
  } finally { f.cleanup(); }
});

test('competing stale-recovery attempts cannot both acquire the instance lock', async () => {
  const f = fixture(); try {
    writeFileSync(f.file, JSON.stringify(record()));
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => acquireInstanceLock(f.file, { probeProcess: () => 'dead' })));
    const acquired = results.filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof acquireInstanceLock>>> => result.status === 'fulfilled');
    try { assert.equal(acquired.length, 1); }
    finally { await Promise.all(acquired.map(result => result.value.release())); }
  } finally { f.cleanup(); }
});

test('shutdown preserves a lock replaced by another owner', async () => {
  const f = fixture(); try {
    const lock = await acquireInstanceLock(f.file), replacement = record();
    writeFileSync(f.file, JSON.stringify(replacement));
    await lock.release();
    assert.equal(JSON.parse(readFileSync(f.file, 'utf8')).token, replacement.token);
  } finally { f.cleanup(); }
});

test('only ESRCH establishes a dead PID; permissions and other probe failures remain unknown', () => {
  assert.equal(processStatus(process.pid), 'alive');
  assert.equal(processStatus(0), 'unknown');
  assert.equal(processStatus(123, () => { throw Object.assign(new Error(), { code: 'ESRCH' }); }), 'dead');
  for (const code of ['EPERM', 'EACCES', 'EINVAL']) assert.equal(processStatus(123, () => { throw Object.assign(new Error(), { code }); }), 'unknown');
});

test('an abruptly terminated lock-owning helper releases its kernel guard and its PID record recovers', { timeout: 10000 }, async () => {
  const f = fixture();
  const moduleUrl = new URL('../src/core/instance-lock.ts', import.meta.url).href;
  const script = `import { acquireInstanceLock } from ${JSON.stringify(moduleUrl)}; await acquireInstanceLock(process.argv[1]); console.log('LOCKED'); setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, f.file], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Lock helper did not become ready')), 5000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.stdout.on('data', data => { if (String(data).includes('LOCKED')) { clearTimeout(timer); resolve(); } });
      child.once('exit', () => { clearTimeout(timer); reject(new Error('Lock helper exited before readiness')); });
    });
    const previous = JSON.parse(readFileSync(f.file, 'utf8')); assert.equal(previous.pid, child.pid);
    child.kill('SIGKILL'); await exited;
    assert.equal(existsSync(f.file), true);
    const recovered = await acquireInstanceLock(f.file);
    assert.equal(recovered.record.pid, process.pid); assert.notEqual(recovered.record.token, previous.token);
    await recovered.release();
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
    f.cleanup();
  }
});
