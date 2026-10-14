import type {AccountOpenOrder} from '../shared/types.js';
import {assertExchangeRequestActive} from './network.js';

function numeric(value:unknown):number {
  return typeof value==='number'||typeof value==='string'&&value.trim()!==''?Number(value):NaN;
}
function identity(value:unknown):string|undefined {
  if(typeof value==='number')return Number.isSafeInteger(value)&&value>0?String(value):undefined;
  return typeof value==='string'&&/^[1-9]\d*$/.test(value)?value:undefined;
}

/** Both native endpoints return the full active array for this symbol, without pagination.
 * /fapi/v1/openOrders does not cover untriggered TP/SL/trailing algo orders.
 * Empty regular orders alone therefore cannot establish that a position is safe to close. */
export async function readBinanceOpenOrders(client:any,market:any):Promise<AccountOpenOrder[]> {
  if(typeof client.fapiPrivateGetOpenOrders!=='function'||typeof client.fapiPrivateGetOpenAlgoOrders!=='function')
    throw new Error('binance: complete native active order observation unavailable');
  assertExchangeRequestActive(client,'binance');
  const reads=await Promise.allSettled([client.fapiPrivateGetOpenOrders({symbol:market.id}),client.fapiPrivateGetOpenAlgoOrders({symbol:market.id})]);
  for(const read of reads)if(read.status==='rejected')throw read.reason;
  assertExchangeRequestActive(client,'binance');
  const responses=reads.map(read=>(read as PromiseFulfilledResult<any>).value);
  const all:AccountOpenOrder[]=[],seen=new Map<string,string>(),size=numeric(market.contractSize);
  if(!(Number.isFinite(size)&&size>0))throw new Error('binance: contract quantity conversion unavailable');
  for(const [index,response] of responses.entries()){
    if(!Array.isArray(response))throw new Error('binance: malformed native active order array');
    const conditional=index===1;
    for(const raw of response){
      const id=identity(conditional?raw?.algoId:raw?.orderId),q=numeric(conditional?raw?.quantity:raw?.origQty),
        filled=conditional?0:numeric(raw?.executedQty),status=conditional?raw?.algoStatus:raw?.status;
      if(!id||raw?.symbol!==market.id||!['BUY','SELL'].includes(raw?.side)||!Number.isFinite(q)||q<0||
        q===0&&(!conditional||raw?.closePosition!==true)||!Number.isFinite(filled)||filled<0||filled>q||
        !(conditional?['NEW','PENDING_NEW','TRIGGERING','TRIGGERED']:['NEW','PENDING_NEW','PARTIALLY_FILLED']).includes(status)||
        raw?.reduceOnly!==undefined&&typeof raw.reduceOnly!=='boolean'||
        raw?.closePosition!==undefined&&typeof raw.closePosition!=='boolean')
        throw new Error('binance: native active order identity or quantity is incomplete');
      const nativeClient=conditional?raw.clientAlgoId:raw.clientOrderId;
      if(nativeClient!==undefined&&typeof nativeClient!=='string')throw new Error('binance: invalid active client order identity');
      const quantity=q*size,remainingQuantity=(q-filled)*size;
      if(!Number.isFinite(quantity)||!Number.isFinite(remainingQuantity))throw new Error('binance: native active order quantity is invalid');
      const row:AccountOpenOrder={id,...(nativeClient?{clientOrderId:nativeClient}:{}),base:market.base,symbol:market.symbol,
        side:raw.side==='BUY'?'buy':'sell',quantity,remainingQuantity,
        ...(typeof raw.reduceOnly==='boolean'?{reduceOnly:raw.reduceOnly}:{}),kind:conditional?'conditional':'regular'};
      const key=`${row.kind}:${id}`,signature=JSON.stringify(row),prior=seen.get(key);
      if(prior!==undefined){if(prior!==signature)throw new Error('binance: conflicting duplicate active order');continue;}
      seen.set(key,signature);all.push(row);
    }
  }
  return all;
}
