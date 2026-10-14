/** Optional exchange fields stay unknown when absent/blank; never coerce them to zero. */
export function positionMetrics(entry:unknown,pnl:unknown,funding?:unknown,feeCashFlow?:unknown,realizedPricePnl?:unknown){
  const numeric=(v:unknown)=>typeof v==='number'||typeof v==='string'&&v.trim()!==''?Number(v):NaN;
  const price=numeric(entry),unrealized=numeric(pnl),paidFunding=numeric(funding),feeFlow=numeric(feeCashFlow),realized=numeric(realizedPricePnl);
  return {...(Number.isFinite(price)&&price>0?{entryPrice:price}:{}),
    ...(Number.isFinite(unrealized)?{unrealizedPnlUsd:unrealized}:{}),
    ...(Number.isFinite(paidFunding)?{fundingUsd:paidFunding}:{}),
    ...(Number.isFinite(feeFlow)?{feesUsd:-feeFlow}:{}),
    ...(Number.isFinite(realized)?{realizedPnlUsd:realized}:{})};
}

/** Exchange lifecycle timestamps are optional. Creation of a symbol setting is not a position opening. */
export function positionTimestamps(opened:unknown,updated:unknown,unit:'milliseconds'|'seconds'='milliseconds'){
  const parse=(v:unknown)=>typeof v==='number'||typeof v==='string'&&v.trim()!==''?Number(v):NaN;
  const scale=unit==='seconds'?1000:1,openedAt=parse(opened)*scale,updatedAt=parse(updated)*scale;
  return {...(Number.isFinite(openedAt)&&openedAt>0?{positionOpenedAt:openedAt}:{}),
    ...(Number.isFinite(updatedAt)&&updatedAt>0?{positionUpdatedAt:updatedAt}:{})};
}
