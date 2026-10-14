import { createHash } from 'node:crypto';
import type { ExchangeId, BookLevel, OrderRequest, OrderResult } from '../shared/types.js';
import {multiplyQuantity} from '../core/order-quantity.js';

export function number(value:unknown, fallback = NaN):number {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value); return Number.isFinite(n) ? n : fallback;
}
export function milliseconds(value:unknown):number {
  const n = number(value); return n > 0 && n < 100_000_000_000 ? n * 1000 : n;
}
export function isEligibleMarket(m:any, base?:string):boolean {
  // An exact base match deliberately never maps 1000PEPE to PEPE or wrapped tokens.
  return Boolean(m && m.active === true && m.swap === true && m.linear === true &&
    m.quote === 'USDT' && m.settle === 'USDT' && number(m.contractSize) > 0 &&
    (!base || m.base === base));
}
export function amountStep(m:any, precisionMode:number):number {
  const p = number(m.precision?.amount);
  const contracts = precisionMode === 4 ? p : precisionMode === 2 ? 10 ** -p : NaN;
  if (!(contracts > 0)) throw new Error(`Unsupported amount precision for ${m.symbol}`);
  return multiplyQuantity(contracts,number(m.contractSize));
}
export interface MarketOrderUnits {
  contractSize:number;contractStep:number;quantityStep:number;minQuantity:number;minNotional:number;maxQuantity?:number;
}
/** Pure, action-only validation of already loaded market rules. No metadata refresh.
 * Native quantity fields are contracts for Gate/OKX and base coins for the others.
 * Missing lower limits are unknown; a reduction's notional exemption is explicit. */
export function marketOrderUnits(exchange:ExchangeId,m:any,precisionMode:number,reduceOnly=false):MarketOrderUnits {
  const fail=(field:string):never=>{throw new Error(`Order unit rules unavailable or conflicting: ${field}`);};
  const read=(value:unknown,field:string,positive=false):number|undefined=>{
    if(value===undefined||value===null||value==='')return;
    if(typeof value!=='number'&&typeof value!=='string'||typeof value==='string'&&value.trim()==='')return fail(field);
    const parsed=Number(value);if(!Number.isFinite(parsed)||(positive?parsed<=0:parsed<0))return fail(field);return parsed;
  };
  const close=(a:number,b:number)=>Math.abs(a-b)<=Number.EPSILON*Math.max(Math.abs(a),Math.abs(b))*8;
  const raw=m.info??{};let rawSize:unknown,rawStep:unknown,rawMinimum:unknown,rawMaximum:unknown,rawNotional:unknown;
  if(exchange==='binance'){
    if(raw.filters!==undefined&&!Array.isArray(raw.filters))fail('filters');
    const filters=raw.filters??[];
    const filter=(name:string)=>{const found=filters.filter((f:any)=>f?.filterType===name);if(found.length>1)fail(name);return found[0];};
    const lot=filter('LOT_SIZE');
    rawStep=lot?.stepSize;rawMinimum=lot?.minQty;rawMaximum=lot?.maxQty;
    if(!reduceOnly){
      const notional=filter('MIN_NOTIONAL'),range=filter('NOTIONAL');
      const lower=read(notional?.notional??notional?.minNotional,'MIN_NOTIONAL'),other=read(range?.minNotional,'NOTIONAL');
      rawNotional=lower===undefined?other:other===undefined?lower:Math.max(lower,other);
    }
  }else if(exchange==='bybit'){
    rawStep=raw.lotSizeFilter?.qtyStep;rawMinimum=raw.lotSizeFilter?.minOrderQty;
    rawMaximum=raw.lotSizeFilter?.maxOrderQty;rawNotional=raw.lotSizeFilter?.minNotionalValue;
  }else if(exchange==='okx'){
    rawSize=raw.ctVal;rawStep=raw.lotSz;rawMinimum=raw.minSz;rawMaximum=raw.maxLmtSz;
    if(raw.ctValCcy!==undefined&&raw.ctValCcy!==m.base)fail('ctValCcy');
  }else if(exchange==='gate'){
    rawSize=raw.quanto_multiplier;rawMinimum=raw.order_size_min;rawMaximum=raw.order_size_max;
    if(raw.enable_decimal!==undefined&&typeof raw.enable_decimal!=='boolean')fail('enable_decimal');
    // Current transport uses integer contract sizes. Do not infer a decimal step
    // from order_size_min or enable_decimal, which only states decimal support.
    if(raw.enable_decimal!==undefined)rawStep=1;
  }else if(exchange==='bitget'){
    rawStep=raw.sizeMultiplier;rawMinimum=raw.minTradeNum;rawMaximum=raw.maxOrderQty;rawNotional=raw.minTradeUSDT;
  }else fail('exchange');
  const normalizedSize=read(m.contractSize,'contractSize',true),nativeSize=read(rawSize,'native contractSize',true);
  if(normalizedSize===undefined||nativeSize!==undefined&&!close(nativeSize,normalizedSize))fail('contractSize');
  const contractSize=nativeSize??normalizedSize!;
  const precision=read(m.precision?.amount,'amount precision'),normalizedStep=precision===undefined?undefined:
    precisionMode===4?read(precision,'amount step',true):precisionMode===2&&Number.isInteger(precision)?10**-precision:fail('precisionMode');
  const nativeStep=read(rawStep,'native quantity step',true);
  if(nativeStep!==undefined&&normalizedStep!==undefined&&!close(nativeStep,normalizedStep))fail('quantity step');
  const contractStep=nativeStep??normalizedStep;if(!(contractStep!>0&&Number.isFinite(contractStep)))fail('quantity step');
  const nativeMinimum=read(rawMinimum,'native quantity minimum'),normalizedMinimum=read(m.limits?.amount?.min,'quantity minimum');
  if(nativeMinimum===undefined&&normalizedMinimum===undefined)fail('quantity minimum');
  // Tighten conflicting limits rather than selecting the more permissive copy.
  const minimum=Math.max(nativeMinimum??0,normalizedMinimum??0);
  const nativeMaximum=read(rawMaximum,'native quantity maximum',true),normalizedMaximum=read(m.limits?.amount?.max,'quantity maximum',true);
  const maximum=nativeMaximum===undefined?normalizedMaximum:normalizedMaximum===undefined?nativeMaximum:Math.min(nativeMaximum,normalizedMaximum);
  if(maximum!==undefined&&maximum<minimum)fail('quantity minimum/maximum');
  let minNotional=0;
  if(!reduceOnly){
    const nativeNotional=read(rawNotional,'native notional minimum'),normalizedNotional=read(m.limits?.cost?.min,'notional minimum');
    if(nativeNotional===undefined&&normalizedNotional===undefined&&!['gate','okx'].includes(exchange))fail('notional minimum');
    minNotional=Math.max(nativeNotional??0,normalizedNotional??0);
  }
  const quantityStep=multiplyQuantity(contractStep!,contractSize),minQuantity=multiplyQuantity(minimum,contractSize),
    maxQuantity=maximum===undefined?undefined:multiplyQuantity(maximum,contractSize);
  if(!(quantityStep>0)||!Number.isFinite(minQuantity)||maxQuantity!==undefined&&!(Number.isFinite(maxQuantity)&&maxQuantity>0))fail('base quantity conversion');
  return {contractSize,contractStep:contractStep!,quantityStep,minQuantity,minNotional,...(maxQuantity===undefined?{}:{maxQuantity})};
}
export function normalizeBook(levels:any[], contractSize:number):BookLevel[] {
  return (levels ?? []).map(([p,q]) => ({price:number(p),quantity:number(q)*contractSize}))
    .filter(x => x.price > 0 && x.quantity > 0);
}
export function fundingClock(id:ExchangeId, funding:any, market:any, history:any[], now:number):{nextFundingTime:number;intervalHours:number} {
  const raw = funding.info ?? {};
  // OKX fundingTime is the next actual settlement; nextFundingTime is one cycle after it.
  const nextFundingTime = id === 'okx'
    ? milliseconds(raw.fundingTime ?? funding.fundingTimestamp)
    : milliseconds(funding.fundingTimestamp ?? raw.nextFundingTime ?? raw.nextUpdate ?? raw.next_funding_time ?? funding.nextFundingTimestamp);
  const intervalText = String(funding.interval ?? '');
  const parsed = /^(\d+(?:\.\d+)?)([hm])$/.exec(intervalText);
  // Current Bybit ticker metadata takes precedence over the interval cached by CCXT at market load.
  let intervalHours = id==='bybit' && number(raw.fundingIntervalHour)>0 ? number(raw.fundingIntervalHour)
    : parsed ? Number(parsed[1]) / (parsed[2] === 'm' ? 60 : 1) : NaN;
  if (!(intervalHours > 0)) {
    if (id === 'okx') intervalHours = (milliseconds(raw.nextFundingTime ?? funding.nextFundingTimestamp) - nextFundingTime) / 3_600_000;
    if (id === 'bybit') intervalHours = number(market.info?.fundingInterval) / 60;
    if (id === 'gate') intervalHours = number(raw.funding_interval ?? market.info?.funding_interval) / 3600;
    if (id === 'binance') intervalHours = number(raw.fundingIntervalHours ?? market.info?.fundingIntervalHours);
    if (id === 'bitget') intervalHours = number(raw.fundingRateInterval ?? raw.ratePeriod ?? market.info?.fundInterval);
  }
  if (!(intervalHours > 0)) {
    const times = history.map(h => number(h.timestamp)).filter(Number.isFinite).sort((a,b)=>a-b);
    if (times.length >= 2) intervalHours = (times.at(-1)! - times.at(-2)!) / 3_600_000;
  }
  // Do not silently assume an 8-hour period or advance stale funding timestamps.
  if (!(nextFundingTime > now && intervalHours > 0 && intervalHours <= 24))
    throw new Error(`${id} funding clock unavailable or stale for ${market.symbol}`);
  return {nextFundingTime,intervalHours};
}
/** Bitget classic USDT contracts are sized directly in base coins (contractSize = 1). */
export function bitgetMarket(raw:any):any {
  const base=String(raw.baseCoin??''),quote=String(raw.quoteCoin??'');
  const swap=raw.symbolType==='perpetual',settle='USDT';
  const priceStep=number(raw.priceEndStep)*10**-number(raw.pricePlace);
  const quantityStep=number(raw.sizeMultiplier);
  if (!base || quote!=='USDT' || !raw.supportMarginCoins?.includes('USDT') || !swap || !(priceStep>0 && quantityStep>0)) return null;
  return {id:raw.symbol,symbol:`${base}/${quote}:${settle}`,base,baseId:base,quote,quoteId:quote,settle,settleId:settle,
    type:'swap',spot:false,margin:false,swap:true,future:false,option:false,contract:true,linear:true,inverse:false,
    active:['normal','online'].includes(raw.symbolStatus??raw.status),contractSize:1,
    taker:number(raw.takerFeeRate),maker:number(raw.makerFeeRate),precision:{amount:quantityStep,price:priceStep},
    limits:{amount:{min:number(raw.minTradeNum),max:number(raw.maxOrderQty,undefined)},cost:{min:number(raw.minTradeUSDT)},
      leverage:{min:number(raw.minLever),max:number(raw.maxLever)},price:{}},info:raw};
}
export function exchangeClientId(id:ExchangeId, original:string):string {
  const digest = createHash('sha256').update(original).digest('hex').slice(0,26);
  return id === 'gate' ? `t-${digest}` : `fa${digest}`;
}
export function unknownOrder(request:OrderRequest, id = ''):OrderResult {
  return {id, clientOrderId:request.clientOrderId,status:'unknown',filledQuantity:0,averagePrice:0,feeUsd:0,timestamp:Date.now()};
}
