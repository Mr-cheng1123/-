import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { usesLocalRoute } from '../scripts/local-route-selection.mjs';

const route = 'http://127.0.0.1:17893';

test('an unused dedicated route does not block an external proxy or direct access', () => {
  assert.equal(usesLocalRoute(17893, { EXCHANGE_PROXY_URL: 'http://127.0.0.1:7890' }), false);
  assert.equal(usesLocalRoute(17893, { EXCHANGE_PROXY_URL: 'direct', HTTPS_PROXY: route }), false);
  assert.equal(usesLocalRoute(17893, { EXCHANGE_PROXY_URL: '', HTTPS_PROXY: route }), false);
  assert.equal(usesLocalRoute(17893, {}), false);
});

test('the app proxy takes precedence over inherited system proxies', () => {
  assert.equal(usesLocalRoute(17893, { EXCHANGE_PROXY_URL: 'http://127.0.0.1:7890', HTTPS_PROXY: route }), false);
  assert.equal(usesLocalRoute(17893, { EXCHANGE_PROXY_URL: route, HTTPS_PROXY: 'http://127.0.0.1:7890' }), true);
});

test('any explicitly isolated exchange can require the dedicated route', () => {
  for (const exchange of ['BINANCE', 'BYBIT', 'OKX', 'GATE', 'BITGET']) {
    assert.equal(usesLocalRoute(17893, { EXCHANGE_PROXY_URL: 'http://127.0.0.1:7890', [`${exchange}_PROXY_URL`]: route }), true);
  }
});

test('venue overrides can remove every dependency on the app proxy', () => {
  const env = { EXCHANGE_PROXY_URL: route };
  for (const exchange of ['BINANCE', 'BYBIT', 'OKX', 'GATE', 'BITGET']) env[`${exchange}_PROXY_URL`] = 'direct';
  assert.equal(usesLocalRoute(17893, env), false);
  env.GATE_PROXY_URL = '';
  assert.equal(usesLocalRoute(17893, env), false);
  delete env.BITGET_PROXY_URL;
  assert.equal(usesLocalRoute(17893, env), true);
});

test('lowercase fallback and HTTPS precedence match exchange transport', () => {
  assert.equal(usesLocalRoute(17893, { https_proxy: route }), true);
  assert.equal(usesLocalRoute(17893, { http_proxy: route }), true);
  assert.equal(usesLocalRoute(17893, { HTTPS_PROXY: 'direct', https_proxy: route }), false);
  assert.equal(usesLocalRoute(17893, { HTTPS_PROXY: '', HTTP_PROXY: route }), false);
  assert.equal(usesLocalRoute(17893, { https_proxy: 'http://127.0.0.1:7890', HTTP_PROXY: route }), false);
});

test('dependency matching checks the loopback host and actual port', () => {
  for (const host of ['127.0.0.1', 'localhost', '[::1]']) {
    for (const protocol of ['http', 'https', 'socks5', 'socks5h']) {
      assert.equal(usesLocalRoute(17893, { EXCHANGE_PROXY_URL: `${protocol}://${host}:17893` }), true);
    }
  }
  assert.equal(usesLocalRoute(17893, { EXCHANGE_PROXY_URL: 'http://remote.invalid:17893' }), false);
  assert.equal(usesLocalRoute(17893, { EXCHANGE_PROXY_URL: 'http://127.0.0.2:17893' }), false);
  assert.equal(usesLocalRoute(17893, { EXCHANGE_PROXY_URL: 'http://127.0.0.1:17894' }), false);
  assert.equal(usesLocalRoute(17893, { EXCHANGE_PROXY_URL: 'http://localhost' }), false);
});

test('port metadata must be a valid dedicated listener port', () => {
  assert.equal(usesLocalRoute('17893', { EXCHANGE_PROXY_URL: route }), true);
  for (const port of [undefined, null, {}, '', '17893junk', NaN, 0, 80, 1023, 65536, 17893.5]) {
    assert.equal(usesLocalRoute(port, { EXCHANGE_PROXY_URL: route }), false);
  }
});

test('proxy authentication is never returned or included in validation errors', () => {
  assert.equal(usesLocalRoute(17893, { EXCHANGE_PROXY_URL: 'http://user:private-canary@localhost:17893' }), true);
  for (const proxy of ['http://private-canary@:bad', 'file:///private-canary']) {
    assert.throws(() => usesLocalRoute(17893, { EXCHANGE_PROXY_URL: proxy }), error => {
      assert.doesNotMatch(error.message, /private-canary/);
      return true;
    });
  }
});

test('prestart reads .env without overriding process proxies or launching an unused route', { skip: process.platform !== 'win32' }, async t => {
  const run = promisify(execFile);
  const base = 'D:\\codex\\tmp\\funding-arb-route-tests';
  await mkdir(base, { recursive: true });
  const fixture = await mkdtemp(join(base, 'startup-'));
  await mkdir(join(fixture, 'scripts'));
  const project = fileURLToPath(new URL('..', import.meta.url));
  await symlink(join(project, 'node_modules'), join(fixture, 'node_modules'), 'junction');
  await Promise.all(['ensure-local-route.mjs', 'local-route-selection.mjs'].map(file =>
    copyFile(join(project, 'scripts', file), join(fixture, 'scripts', file))));
  await writeFile(join(fixture, 'scripts/start-local-route.ps1'),
    "[IO.File]::WriteAllText((Join-Path $PSScriptRoot '..\\route-started.txt'), 'stub-only')");
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: base, TMP: base };
  const marker = join(fixture, 'route-started.txt');
  async function markerExists() {
    try { await readFile(marker); return true; }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  }
  const launch = values => run(process.execPath, ['scripts/ensure-local-route.mjs'],
    { cwd: fixture, env: { ...env, ...values }, windowsHide: true, timeout: 10000 });
  await writeFile(join(fixture, 'route.local.json'), JSON.stringify({ port: 17893 }));
  await writeFile(join(fixture, '.env'), `EXCHANGE_PROXY_URL=${route}\n`);
  await t.test('parent 7890 override skips the route configured in .env', async () => {
    await launch({ EXCHANGE_PROXY_URL: 'http://127.0.0.1:7890' });
    assert.equal(await markerExists(), false);
  });
  await t.test('parent direct override also skips the route', async () => {
    await launch({ EXCHANGE_PROXY_URL: 'direct' });
    assert.equal(await markerExists(), false);
  });
  await t.test('a .env 7890 selection overrides inherited HTTPS_PROXY', async () => {
    await writeFile(join(fixture, '.env'), 'EXCHANGE_PROXY_URL=http://127.0.0.1:7890\n');
    await launch({ HTTPS_PROXY: route });
    assert.equal(await markerExists(), false);
  });
  await t.test('unreadable route metadata cannot start an unproven dependency', async () => {
    await writeFile(join(fixture, 'route.local.json'), '{');
    const result = await launch({ EXCHANGE_PROXY_URL: 'http://127.0.0.1:7890' });
    assert.match(result.stderr, /未启动/);
    assert.equal(await markerExists(), false);
    await writeFile(join(fixture, 'route.local.json'), JSON.stringify({ port: 17893 }));
  });
  await t.test('an effective .env dependency invokes only the isolated PowerShell stub', async () => {
    await writeFile(join(fixture, '.env'), `EXCHANGE_PROXY_URL=${route}\n`);
    await launch({});
    assert.equal(await readFile(marker, 'utf8'), 'stub-only');
  });
});
