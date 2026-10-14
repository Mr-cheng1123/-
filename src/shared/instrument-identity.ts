import type { ExchangeId } from './types.js';

// Official descriptions conflict; this is not proof that the actual price indices differ.
// Bitget calls HANMI Hanmi Pharm and SAMSUNGEM Samsung E&A:
// https://www.bitget.com/support/articles/12560603892049
// Gate identifies HANMI as Hanmi Semiconductor (042700.KS):
// https://www.gate.com/announcements/article/101141
// Gate identifies SAMSUNGEM as Samsung Electro-Mechanics:
// https://www.gate.com/zh/announcements/article/100310
// Keep rates visible, but require authoritative instrument/index mapping before a cross-venue hedge.
const unresolvedBitgetSymbols=new Set(['HANMI','SAMSUNGEM']);

export function instrumentIdentityBlockReason(base:string,a:ExchangeId,b:ExchangeId):string|undefined {
  // The same ticker names two assets. Keep quotes/holdings visible but never
  // treat the nominal price difference as a same-asset hedge opportunity.
  // https://www.gate.com/futures/USDT/EDGE_USDT (Definitive)
  // https://announcements.bybit.com/en/article/bybit-to-list-edgex-edge-on-spot-bltd4be4f509909110a/
  // https://www.binance.com/zh-CN/support/announcement/detail/f4038a3dbd6d49318c2ee201051fe43e
  // https://www.okx.com/en-gb/help/okx-to-list-perpetual-futures-for-edge-crypto
  if(base.toUpperCase()==='EDGE'&&a!==b&&(a==='gate'||b==='gate')){
    const other=a==='gate'?b:a;
    return ['bybit','binance','okx'].includes(other)
      ?`EDGE 同名不同标的：Gate 为 Definitive，${other} 为 edgeX，不能组成同币对冲`
      :'EDGE 标的身份待核验：Gate 为 Definitive，须确认另一所对应资产后才能配对';
  }
  if(a===b||!unresolvedBitgetSymbols.has(base.toUpperCase())||a!=='bitget'&&b!=='bitget')return undefined;
  return `${base} 官方标的身份待核验：Bitget 公告与跨所资料描述矛盾，尚不能确认是同一标的`;
}
