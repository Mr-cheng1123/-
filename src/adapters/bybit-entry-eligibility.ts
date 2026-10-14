import type {OrderRequest} from '../shared/types.js';
import {OrderNotSubmittedError} from './order-rejection.js';

function record(value:unknown):Record<string,unknown>|undefined{
  return value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:undefined;
}

function extraProductMarker(value:unknown):boolean{
  // A malformed provided marker is not proof that this is an ordinary crypto contract.
  return value!==undefined&&value!==null&&(typeof value!=='string'||value.trim()!=='');
}

/**
 * Local guard for a concrete live opening request; no HTTP or account mutation.
 * Official symbolType values and TradFi metadata:
 * https://bybit-exchange.github.io/docs/v5/enum#symboltype
 * https://bybit-exchange.github.io/docs/zh-TW/v5/tradfi-integration
 * Account instruments-info does not expose agreement acceptance or ordinary trade permission.
 * Its successful Trading response cannot authorize a TradFi opening.
 */
export function assertBybitEntryEligibility(market:unknown,request:Pick<OrderRequest,'reduceOnly'>):void{
  // Manual exits, emergency reductions and abnormal-entry rollback keep their existing guards.
  if(request.reduceOnly)return;
  const info=record(record(market)?.info);
  if(!info)return;
  const type=info.symbolType;
  const ordinaryType=type===undefined||type===null||type===''||type==='innovation';
  if(ordinaryType&&!extraProductMarker(info.marketRegion)&&!extraProductMarker(info.underlyingTicker))return;
  const reason='Bybit 合约带有股票、ETF、商品、外汇或未识别的额外产品标识；现有元数据不能证明交易协议及账户准入已满足，需要先核对准入，本次未发送开仓订单。';
  throw new OrderNotSubmittedError('bybit: additional product access is not verified','UNVERIFIED_PRODUCT_ACCESS',reason);
}
