import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { usesLocalRoute } from './local-route-selection.mjs';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: resolve(project, '.env'), quiet: true, override: false });
const routeConfig = resolve(project, 'route.local.json');
let routePort;
if (process.platform === 'win32' && existsSync(routeConfig)) {
  try { routePort = JSON.parse(readFileSync(routeConfig, 'utf8').replace(/^\uFEFF/, '')).port; }
  catch { console.warn('本机专用连接配置无效，未启动无法确认使用的线路。'); }
}
if (process.platform === 'win32' && usesLocalRoute(routePort, process.env)) {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', resolve(project, 'scripts/start-local-route.ps1')], {
    cwd: project, windowsHide: true, stdio: 'inherit', timeout: 30_000,
  });
  if (result.error || result.status !== 0) {
    console.error('本机专用连接未能启动，请检查 route.local.json 的文件路径、节点名称和端口占用。');
    process.exit(1);
  }
}
