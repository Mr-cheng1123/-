import type {AppConfig,ExchangeId,Position} from './types.js';

type FeeRebateConfig=Pick<AppConfig,'feeRebatePct'>;

/** A user-confirmed automatic rebate, not an observed exchange fee or an actual cash receipt. */
export function feeRebatePct(exchange:ExchangeId,config:FeeRebateConfig):number {
  const percentage=config.feeRebatePct?.[exchange];
  return typeof percentage==='number'&&Number.isFinite(percentage)&&percentage>=0&&percentage<=100?percentage:0;
}

/** Apply only after native/source/freshness validation. Negative native Maker rebates remain unchanged. */
export function effectiveFeeRate(exchange:ExchangeId,grossRate:number|undefined,config:FeeRebateConfig):number|undefined {
  if(grossRate===undefined||!Number.isFinite(grossRate))return;
  return grossRate>0?grossRate*(1-feeRebatePct(exchange,config)/100):grossRate;
}

/** Positive fee expense alone generates an estimated rebate; unknown expenses never become zero. */
export function estimateFeeRebateUsd(exchange:ExchangeId,grossFeeUsd:number,config:FeeRebateConfig):number {
  if(!Number.isFinite(grossFeeUsd))return NaN;
  return grossFeeUsd>0?grossFeeUsd*feeRebatePct(exchange,config)/100:0;
}

export function feeRebateBreakdown(exchange:ExchangeId,grossFeesUsd:number,config:FeeRebateConfig) {
  const estimatedFeeRebateUsd=estimateFeeRebateUsd(exchange,grossFeesUsd,config);
  return {grossFeesUsd,estimatedFeeRebateUsd,effectiveFeesUsd:grossFeesUsd-estimatedFeeRebateUsd};
}

/** Exact per-order positive-fee projection takes precedence. Old groups can use net leg aggregates
 * as a conservative fallback, which never manufactures a rebate from negative native Maker cash. */
export function estimatedPositionFeeRebateUsd(p:Pick<Position,'long'|'short'|'estimatedFeeRebateUsd'>,config:FeeRebateConfig):number|undefined {
  if(p.estimatedFeeRebateUsd!==undefined)return p.estimatedFeeRebateUsd!==null&&Number.isFinite(p.estimatedFeeRebateUsd)&&p.estimatedFeeRebateUsd>=0?
    p.estimatedFeeRebateUsd:undefined;
  const rebates=[p.long,p.short].map(leg=>estimateFeeRebateUsd(leg.exchange,leg.feesUsd,config));
  return rebates.every(Number.isFinite)?rebates[0]+rebates[1]:undefined;
}
