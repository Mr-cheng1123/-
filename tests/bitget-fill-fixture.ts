/** Offline fill coverage for the synthetic orders used in integration fixtures. */
export function attachBitgetFillFixture(client:any,onRead?:(params:any)=>void){
  let source=client.privateUtaGetV3TradeOrderInfo,last:any;
  const tracked=async(params:any)=>{const response=await source(params);last=response?.data;return response;};
  Object.defineProperty(client,'privateUtaGetV3TradeOrderInfo',{configurable:true,get:()=>tracked,set:value=>{source=value;}});
  if(typeof client.privateUtaGetV3TradeFills==='function')return;
  client.privateUtaGetV3TradeFills=async(params:any)=>{
    onRead?.(params);
    const raw=last,reduce=String(raw?.reduceOnly).toUpperCase()==='YES',side=raw?.side;
    const position=reduce?(side==='sell'?'long':'short'):(side==='buy'?'long':'short');
    return {code:'00000',data:{list:raw&&Number(raw.cumExecQty)>0?[{
      execId:`offline-fill-${raw.orderId}`,orderId:raw.orderId,clientOid:raw.clientOid,category:raw.category,symbol:raw.symbol,
      side,orderType:raw.orderType,tradeSide:raw.tradeSide??`${reduce?'close':'open'}_${position}`,
      execQty:raw.cumExecQty,execPrice:raw.avgPrice,feeDetail:raw.feeDetail,
    }]:[],cursor:null}};
  };
}
