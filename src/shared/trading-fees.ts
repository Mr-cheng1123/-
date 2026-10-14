import type {AppConfig,MarketSnapshot} from './types.js';
import {referenceTradingFee} from './reference-trading-fees.js';

export const NATIVE_TRADING_FEE_MAX_AGE_MS=120_000;

/** A symbol-specific account observation, never a rate inferred from accumulated paid fees. */
export function nativeTakerFeeRate(snapshot:Pick<MarketSnapshot,'takerFeeRate'|'takerFeeAt'|'takerFeeSource'>|undefined,now=Date.now()):number|undefined {
  if(!snapshot||snapshot.takerFeeSource!=='exchange'||!Number.isFinite(snapshot.takerFeeRate)||snapshot.takerFeeRate!<0||snapshot.takerFeeRate!>1||
    !Number.isFinite(snapshot.takerFeeAt)||snapshot.takerFeeAt!<=0||snapshot.takerFeeAt!>now+5000||now-snapshot.takerFeeAt!>NATIVE_TRADING_FEE_MAX_AGE_MS)return;
  return snapshot.takerFeeRate;
}

/** A separate official Maker observation: positive expense, negative rebate; never inferred from Taker. */
export function nativeMakerFeeRate(snapshot:Pick<MarketSnapshot,'makerFeeRate'|'makerFeeAt'|'makerFeeSource'>|undefined,now=Date.now()):number|undefined {
  if(!snapshot||snapshot.makerFeeSource!=='exchange'||!Number.isFinite(snapshot.makerFeeRate)||Math.abs(snapshot.makerFeeRate!)>.01||
    !Number.isFinite(snapshot.makerFeeAt)||snapshot.makerFeeAt!<=0||snapshot.makerFeeAt!>now+5000||now-snapshot.makerFeeAt!>NATIVE_TRADING_FEE_MAX_AGE_MS)return;
  return snapshot.makerFeeRate;
}

/** Local estimates prefer an observed account rate, then its saved reference, then the official public schedule. */
export function estimatedTakerFeeRate(snapshot:Pick<MarketSnapshot,'exchange'|'symbol'|'feeProfile'|'feeReference'|'takerFeeRate'|'takerFeeAt'|'takerFeeSource'>|undefined,now=Date.now()):number|undefined {
  if(!snapshot)return;
  const native=nativeTakerFeeRate(snapshot,now);if(native!==undefined)return native;
  const saved=snapshot.feeReference;
  if(saved?.source==='account-reference'&&Number.isFinite(saved.observedAt)&&saved.observedAt>0&&saved.observedAt<=now&&
    Number.isFinite(saved.takerRate)&&saved.takerRate>=0&&saved.takerRate<=.01)return saved.takerRate;
  return referenceTradingFee(snapshot.exchange,snapshot.symbol,snapshot.feeProfile)?.takerRate;
}

/** Default live calculations remain strict. Only an explicit estimate opts into local official references. */
export function takerFeeRate(snapshot:MarketSnapshot,config:AppConfig,now=Date.now(),requireNative=config.mode==='live'):number|undefined {
  const native=nativeTakerFeeRate(snapshot,now);
  if(native!==undefined)return native;
  if(requireNative)return;
  if(config.mode==='live')return estimatedTakerFeeRate(snapshot,now);
  const configured=config.takerFees[snapshot.exchange];
  return Number.isFinite(configured)&&configured>=0?configured:undefined;
}
