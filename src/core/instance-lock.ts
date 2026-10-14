import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer, type ListenOptions, type Server } from 'node:net';
import { hostname, uptime } from 'node:os';
import path from 'node:path';

export type ProcessStatus = 'alive' | 'dead' | 'unknown';
export interface InstanceLockRecord {
  version: 1; app: 'funding-arb'; pid: number; token: string; hostname: string; createdAt: number;
}
export interface InstanceLock {
  readonly record: InstanceLockRecord;
  release(): Promise<void>;
  releaseSync(): void;
}
export class InstanceLockError extends Error {
  constructor(readonly code: 'active' | 'unknown' | 'contended' | 'io', message: string) {
    super(message); this.name = 'InstanceLockError';
  }
}

/** Signal zero only checks existence; EPERM and any unexpected failure are deliberately inconclusive. */
export function processStatus(pid: number, probe: (pid: number, signal: number) => unknown = process.kill): ProcessStatus {
  if (!Number.isSafeInteger(pid) || pid <= 0) return 'unknown';
  try { probe(pid, 0); return 'alive'; }
  catch (error) { return (error as NodeJS.ErrnoException)?.code === 'ESRCH' ? 'dead' : 'unknown'; }
}

function readRecord(lockPath: string): InstanceLockRecord | undefined {
  try {
    const stat = lstatSync(lockPath);
    if (!stat.isFile() || stat.size > 4096) throw new Error('Invalid lock file');
    const record = JSON.parse(readFileSync(lockPath, 'utf8'));
    if (record.version !== 1 || record.app !== 'funding-arb' || !Number.isSafeInteger(record.pid) || record.pid <= 0 ||
      typeof record.token !== 'string' || !/^[0-9a-f-]{36}$/i.test(record.token) || typeof record.hostname !== 'string' || !record.hostname ||
      !Number.isFinite(record.createdAt) || record.createdAt <= 0) throw new Error('Invalid lock owner');
    return record;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return undefined;
    throw new InstanceLockError('unknown', `无法确认实例锁的原进程（包括旧版空锁）：${lockPath}。请先确认旧进程已停止，再处理该锁。`);
  }
}

function closeGuard(guard: Server): Promise<void> {
  return new Promise(resolve => { if (!guard.listening) return resolve(); guard.close(() => resolve()); });
}

async function acquireGuard(lockPath: string): Promise<Server> {
  const key = process.platform === 'win32' ? lockPath.toLowerCase() : lockPath;
  const digest = createHash('sha256').update(key).digest('hex');
  // Kernel-owned endpoints disappear on process termination. Filesystem socket paths would themselves leave stale locks.
  const address: ListenOptions = process.platform === 'win32' ? { path: `\\\\.\\pipe\\funding-arb-lock-${digest}` }
    : process.platform === 'linux' ? { path: `\0funding-arb-lock-${digest}` }
      : { host: '127.0.0.1', port: 49152 + Number.parseInt(digest.slice(0, 4), 16) % 16384 };
  const guard = createServer(socket => { socket.on('error', () => {}); socket.destroy(); });
  try {
    await new Promise<void>((resolve, reject) => {
      guard.once('error', reject);
      guard.listen({ ...address, exclusive: true }, () => { guard.removeListener('error', reject); resolve(); });
    });
    guard.on('error', () => {}); guard.unref(); return guard;
  } catch {
    throw new InstanceLockError('contended', `已有实例占用启动互斥锁，或系统无法确认独占状态：${lockPath}`);
  }
}

/** The kernel guard serializes stale-file recovery and remains held for the full instance lifetime. */
export async function acquireInstanceLock(filename: string, options: { probeProcess?: (pid: number) => ProcessStatus; bootTimeMs?: number } = {}): Promise<InstanceLock> {
  mkdirSync(path.dirname(path.resolve(filename)), { recursive: true });
  const lockPath = path.join(realpathSync(path.dirname(path.resolve(filename))), path.basename(filename));
  const guard = await acquireGuard(lockPath);
  let temporary: string | undefined;
  try {
    const previous = readRecord(lockPath);
    if (previous) {
      let status: ProcessStatus = previous.hostname === hostname() ? (options.probeProcess ?? processStatus)(previous.pid) : 'unknown';
      // A record written before the machine booted cannot belong to a running process: its PID may since have been
      // reused by an unrelated program, which would otherwise block every start after an unclean shutdown or reboot.
      const bootTime = options.bootTimeMs ?? Date.now() - uptime() * 1000;
      if (status === 'alive' && previous.hostname === hostname() && previous.createdAt < bootTime - 60_000) status = 'dead';
      if (status !== 'dead') throw new InstanceLockError(status === 'alive' ? 'active' : 'unknown',
        status === 'alive' ? `同模式进程 PID ${previous.pid} 仍存在，拒绝启动第二实例。` : `无法确认锁所属进程 PID ${previous.pid} 已退出，保留实例锁：${lockPath}`);
      unlinkSync(lockPath);
    }
    const record: InstanceLockRecord = { version: 1, app: 'funding-arb', pid: process.pid, token: randomUUID(), hostname: hostname(), createdAt: Date.now() };
    temporary = `${lockPath}.${record.token}.tmp`;
    const fd = openSync(temporary, 'wx', 0o600);
    try { writeFileSync(fd, `${JSON.stringify(record)}\n`, 'utf8'); fsyncSync(fd); }
    finally { closeSync(fd); }
    // Publish a complete record atomically and without overwriting an independently created lock.
    linkSync(temporary, lockPath); unlinkSync(temporary); temporary = undefined;
    let released = false;
    const releaseSync = () => {
      if (released) return;
      released = true; process.removeListener('exit', releaseSync);
      try {
        const current = readRecord(lockPath);
        if (current?.token === record.token && current.pid === record.pid && current.hostname === record.hostname) unlinkSync(lockPath);
      } catch { /* Unknown/replaced locks must survive this process's cleanup. */ }
    };
    process.once('exit', releaseSync);
    return { record,
      releaseSync,
      async release() { releaseSync(); await closeGuard(guard); },
    };
  } catch (error) {
    if (temporary) { try { unlinkSync(temporary); } catch { /* Never remove another owner's canonical lock. */ } }
    await closeGuard(guard);
    if (error instanceof InstanceLockError) throw error;
    throw new InstanceLockError('io', `无法创建实例锁：${lockPath}。请检查数据目录权限及文件系统硬链接支持。`);
  }
}
