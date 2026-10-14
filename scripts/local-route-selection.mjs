const exchanges = ['binance', 'bybit', 'okx', 'gate', 'bitget'];
const proxyProtocols = new Set(['http:', 'https:', 'socks5:', 'socks5h:']);
const loopbackHosts = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** Match the effective per-exchange proxy precedence in adapters/network.ts. */
function effectiveProxy(exchange, env) {
  const value = env[`${exchange.toUpperCase()}_PROXY_URL`] ?? env.EXCHANGE_PROXY_URL ??
    env.HTTPS_PROXY ?? env.https_proxy ?? env.HTTP_PROXY ?? env.http_proxy;
  if (!value || value.toLowerCase() === 'direct') return undefined;
  let proxy;
  try { proxy = new URL(value); }
  catch { throw new Error('代理地址格式无效，应为 http://主机:端口'); }
  if (!proxyProtocols.has(proxy.protocol)) throw new Error('代理协议仅支持 HTTP、HTTPS 或 SOCKS5');
  return proxy;
}

/** Never start an unused dedicated route merely because its configuration exists. */
export function usesLocalRoute(port, env = {}) {
  if (!['number', 'string'].includes(typeof port)) return false;
  const routePort = Number(port);
  if (!Number.isInteger(routePort) || routePort < 1024 || routePort > 65535) return false;
  return exchanges.some(exchange => {
    const proxy = effectiveProxy(exchange, env);
    return proxy !== undefined && loopbackHosts.has(proxy.hostname) && Number(proxy.port) === routePort;
  });
}
