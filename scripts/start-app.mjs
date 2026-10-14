import { spawn, spawnSync } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import dotenv from 'dotenv';
import {openDesktopWindow} from './desktop-window.mjs';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: resolve(project, '.env'), quiet: true });
const port = Number(process.env.PORT ?? 8787);
const noBrowser = process.argv.includes('--no-browser');
const noWindow = process.argv.includes('--no-window');

async function health(url) {
  try {
    const response = await fetch(`${url}api/health`, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) return null;
    const value = await response.json();
    return value.ok === true && value.app === 'funding-arb' && Number.isSafeInteger(value.pid) ? value : null;
  } catch { return null; }
}

function portIsFree() {
  return new Promise(resolveFree => {
    const probe = createServer();
    probe.once('error', () => resolveFree(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolveFree(true)));
  });
}

function openBrowser(url) {
  if (noBrowser) return;
  const command = process.platform === 'win32' ? 'rundll32.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  const browser = spawn(command, args, { detached: true, windowsHide: true, stdio: 'ignore' });
  browser.on('error', () => console.log(`请在浏览器打开 ${url}`));
  browser.unref();
}

async function main() {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PORT 必须为 1024–65535 的整数。');
  const url = `http://127.0.0.1:${port}/`;
  const existing = await health(url);
  if (existing) {
    const expectedMode = process.env.TRADING_MODE === 'live' ? 'live' : 'paper';
    if (existing.mode !== expectedMode) throw new Error(`现有服务为 ${existing.mode} 模式，配置要求 ${expectedMode}。请先停止原服务并保留账本，再重新启动；启动器不会自动终止交易进程。`);
    console.log(`服务已在运行（PID ${existing.pid}）：${url}`);
    openBrowser(url);
    if(!noWindow){await openDesktopWindow({url,pid:existing.pid,project});if(process.platform==='win32')console.log('任务栏窗口已打开，可点击“退出软件”或右上角关闭按钮安全退出。');}
    return;
  }
  if (!await portIsFree()) throw new Error(`本机端口 ${port} 已被占用，且未识别为资金费率工作台。请检查端口设置。`);

  const route = spawnSync(process.execPath, [resolve(project, 'scripts/ensure-local-route.mjs')], {
    cwd: project, windowsHide: true, stdio: 'inherit', timeout: 35_000,
  });
  if (route.error || route.status !== 0) throw new Error('行情连接未能恢复。请检查本机连接配置后重新启动。');

  const logs = resolve(project, 'data/runtime');
  mkdirSync(logs, { recursive: true });
  const stdout = openSync(resolve(logs, 'server.log'), 'a');
  const stderr = openSync(resolve(logs, 'server-error.log'), 'a');
  let child;
  try {
    child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
      cwd: project, env: process.env, detached: true, windowsHide: true, stdio: ['ignore', stdout, stderr],
    });
  } finally { closeSync(stdout); closeSync(stderr); }
  let launchError = false;
  child.on('error', () => { launchError = true; });
  child.unref();
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const running = await health(url);
    if (running) {
      console.log(`服务已就绪（PID ${running.pid}）：${url}`);
      console.log(noWindow?'服务在后台运行。电脑重启后请再次双击 start.cmd。':'任务栏“资金费率套利”窗口可打开页面或退出软件。关闭浏览器不会停止后台。');
      openBrowser(url);
      if(!noWindow)await openDesktopWindow({url,pid:running.pid,project});
      return;
    }
    if (launchError || child.exitCode !== null || child.signalCode !== null) break;
    await delay(300);
  }
  throw new Error(`服务尚未就绪。请查看 ${resolve(logs, 'server-error.log')}；启动器未更改交易设置或删除账本。`);
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
