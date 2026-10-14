import type {ExchangeId} from './types.js';

export type ReferenceTradingFeeProfile='standard'|'innovation'|'pre-market'|'unknown';

/** Local public schedule for opportunity estimates, never a native account fee observation. */
export interface ReferenceTradingFee {
  readonly exchange:ExchangeId;
  readonly symbol:string;
  readonly source:'official-reference';
  readonly makerRate:number;
  readonly takerRate:number;
  readonly profile:ReferenceTradingFeeProfile;
  /** Date the official schedule was reviewed, not the time an account rate was fetched. */
  readonly verifiedAt:number;
  readonly sourceUrl:string;
  readonly caveats:readonly string[];
}

export const REFERENCE_TRADING_FEE_VERIFIED_AT=Date.UTC(2026,9,4);

const COMMON_CAVEATS=[
  '仅供机会估算；不是账户实际手续费，开仓或平仓前必须按具体合约核实账户费率。',
  '官方基准可能因地区、账户等级、专属费率、折扣或活动变化；本地参考值不是收费保证或费率上限。'
] as const;

const SCHEDULES={
  binance:{makerRate:.0002,takerRate:.0005,sourceUrl:'https://www.binance.com/en/support/faq/detail/360033544231',
    caveats:['普通 USDⓈ-M USDT 永续基准；不计 VIP、BNB 支付折扣和返佣，TradFi 或特殊活动合约需核对单独费率。']},
  bybit:{makerRate:.0002,takerRate:.00055,sourceUrl:'https://www.bybit.com/en/help-center/article/Trading-Fee-Structure',
    caveats:['普通永续 VIP 0 基准；创新区和盘前合约采用不同费率，地区费率以已验证账户显示为准。']},
  gate:{makerRate:.0002,takerRate:.0005,sourceUrl:'https://www.gate.com/zh/announcements/article/43029',
    caveats:['USDT 永续 VIP 0 基准；Points 支付可能按 0.075% 吃单费率扣除，不计 VIP、做市商及报名折扣。',
      '公开合约接口的 maker_fee_rate/taker_fee_rate 不代表账户 VIP 费率；TradFi 自 2026-09-01 采用独立费率表。']},
  bitget:{makerRate:.0002,takerRate:.0006,sourceUrl:'https://www.bitget.com/support/articles/12560603892734',
    caveats:['普通 USDT 永续非 VIP 基准；不计 VIP、做市商及活动费率，BGB 现货支付折扣不能直接套入永续。']}
} as const;

/**
 * Reads only the bundled official reference schedule. The canonical CCXT USDT swap symbol is required
 * so a spot, delivery or inverse contract cannot silently inherit a perpetual fee. `standard` must be
 * selected from verified contract classification, never inferred from a base name or a low account rate.
 * Bybit unknown classification uses its published Innovation Zone VIP 0 reference, not a guaranteed cap.
 * No credential access, account requests, native fee fields, expiry refresh or runtime cache is involved.
 */
export function referenceTradingFee(exchange:ExchangeId,symbol:string,profile:ReferenceTradingFeeProfile='unknown'):ReferenceTradingFee|undefined {
  if(typeof symbol!=='string'||!/^[^\s/:]+\/USDT:USDT$/.test(symbol)||exchange==='okx')return;
  if(profile!=='standard'&&profile!=='innovation'&&profile!=='pre-market'&&profile!=='unknown')return;
  if(!Object.hasOwn(SCHEDULES,exchange))return;
  const schedule=SCHEDULES[exchange];
  if(exchange!=='bybit'&&(profile==='innovation'||profile==='pre-market'))return;
  const special=exchange==='bybit'&&profile!=='standard';
  const makerRate=special?.0004:schedule.makerRate;
  const takerRate=special?(profile==='pre-market'?.0010:.0011):schedule.takerRate;
  const caveats:string[]=[...COMMON_CAVEATS,...schedule.caveats];
  if(profile==='unknown')caveats.push(exchange==='bybit'
    ?'合约费率分类尚未确认；暂按创新区 VIP 0 的 0.04% Maker / 0.11% Taker 估算，仍不保证覆盖所有特殊费率。'
    :'合约费率分类尚未确认；当前采用普通合约基准，特殊合约费率可能不同。');
  else if(profile==='innovation')caveats.push('采用 Bybit 创新区 VIP 0 基准，未计专属账户费率；以具体合约实际账户费率为准。');
  else if(profile==='pre-market')caveats.push('采用 Bybit 盘前连续交易 VIP 0 基准；集合竞价阶段收费规则不同。');
  return Object.freeze({exchange,symbol,source:'official-reference',makerRate,takerRate,profile,
    verifiedAt:REFERENCE_TRADING_FEE_VERIFIED_AT,sourceUrl:schedule.sourceUrl,caveats:Object.freeze(caveats)});
}
