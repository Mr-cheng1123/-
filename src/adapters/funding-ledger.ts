import type { ExchangeId, FundingPayment } from '../shared/types.js';
import { bitgetData } from './bitget-classic.js';
import {assertExchangeRequestActive} from './network.js';

const PAGE_SIZE = 100;
const MAX_PAGES = 200;
const WEEK = 7*86400000;

const absent=(value:unknown)=>value==null||typeof value==='string'&&value.trim()==='';
const numeric=(value:unknown):number=>typeof value==='number'||typeof value==='string'&&value.trim()!==''?Number(value):NaN;
const invoiceId=(value:unknown):string|undefined=>typeof value==='string'&&value.trim()!==''?value:
  typeof value==='number'&&Number.isSafeInteger(value)&&value>=0?String(value):undefined;
const okxCash=(raw:any):number=>{
  // The official archive specifies pnl as funding payment for expense subtype 173.
  // It is the same cash flow, not a second amount to add to balance changes.
  if(String(raw.subType)==='173')return numeric(raw.pnl);
  // Cross bills move account balance; isolated bills can move only position balance.
  // An explicitly reported zero is known cash. Missing/invalid fields are not zero.
  const account=numeric(raw.balChg),position=numeric(raw.posBalChg);
  if(!absent(raw.balChg)&&!Number.isFinite(account))return NaN;
  if(Number.isFinite(account)&&account!==0)return account;
  if(!absent(raw.posBalChg)&&!Number.isFinite(position))return NaN;
  return Number.isFinite(position)?position:account;
};

/** Fixed upper bound prevents a moving newest page from skipping or duplicating settlements. */
export async function readFundingLedger(client:any,id:ExchangeId,since:number,until=Date.now(),observedAt=Date.now()):Promise<FundingPayment[]> {
  if (!(Number.isFinite(since) && Number.isFinite(until) && since>=0 && until>=since)) throw new Error('Invalid funding reconciliation window');
  if(id==='bitget'&&until-since>90*86400000)throw new Error('bitget: classic funding ledger only supports the last 90 days; archive older invoices separately');
  if(!Number.isFinite(observedAt))throw new Error('Invalid funding archive observation time');
  if(id==='binance'||id==='okx'){
    const cutoff=new Date(observedAt),day=cutoff.getUTCDate();
    cutoff.setUTCDate(1);cutoff.setUTCMonth(cutoff.getUTCMonth()-3);
    const lastDay=new Date(Date.UTC(cutoff.getUTCFullYear(),cutoff.getUTCMonth()+1,0)).getUTCDate();
    cutoff.setUTCDate(Math.min(day,lastDay));
    if(since<cutoff.getTime())throw new Error(`${id}: funding archive only supports the last 3 months; older coverage requires separate archived invoices`);
  }
  if(id==='bitget'&&since<observedAt-90*86400000)throw new Error('bitget: classic funding ledger only supports the last 90 days; archive older invoices separately');
  const payments = new Map<string,FundingPayment>();
  let pages = 0;
  const fetch = async (fn:()=>Promise<any>) => {
    assertExchangeRequestActive(client,id);
    if (++pages>MAX_PAGES) throw new Error(`${id}: funding pagination limit reached; reconcile a narrower window`);
    const response=await fn();
    // An unabortable native read may still finish after its logical deadline.
    // It cannot prove complete coverage or authorize another page/time slice.
    assertExchangeRequestActive(client,id);
    return response;
  };
  const add = (raw:any) => {
    if(id==='bitget'&&raw.businessType!=='contract_settle_fee')return;
    const currency = id==='binance' ? raw.asset : id==='okx' ? raw.ccy : id==='bitget'?raw.coin:'USDT';
    if (currency !== 'USDT') return;
    const nativeTime=numeric(id==='binance' ? raw.time : id==='bybit' ? raw.execTime : id==='okx' ? raw.ts : id==='bitget'?raw.cTime:raw.time);
    // Gate reports fractional Unix seconds; the other native sources report milliseconds.
    const timestamp=id==='gate'?nativeTime*1000:nativeTime;
    if(!(Number.isFinite(timestamp)&&timestamp>0))throw new Error(`${id}: invalid funding ledger amount/time`);
    // Gate's integer-second GET bounds include padding outside our exact millisecond window.
    // Such invoices may refer to delisted markets and must not block this reconciliation.
    if(timestamp<since||timestamp>until)return;
    const marketId = id==='okx' ? raw.instId : id==='gate' ? raw.contract ?? String(raw.text??'').split(':')[0] : raw.symbol;
    const m:any = Object.values(client.markets).find((m:any)=>m.id===marketId && m.swap && m.linear && m.settle==='USDT');
    if (!m) throw new Error(`${id}: cannot identify funding ledger market`);
    const amountUsd = id==='binance' ? numeric(raw.income) : id==='bybit' ? -numeric(raw.execFee)
      : id==='gate' ? numeric(raw.change) : id==='bitget'?numeric(raw.amount):okxCash(raw);
    if(id==='bitget'&&((absent(raw.fee)?0:numeric(raw.fee))!==0||(absent(raw.feeByCoupon)?0:numeric(raw.feeByCoupon))!==0))throw new Error('bitget: unexpected fee in funding invoice; manual reconciliation required');
    if (![timestamp,amountUsd].every(Number.isFinite)) throw new Error(`${id}: invalid funding ledger amount/time`);
    const rawId=invoiceId(id==='binance'?raw.tranId:id==='bybit'?raw.execId:id==='okx'||id==='bitget'?raw.billId:raw.id);
    // Distinct native invoices can have identical timestamps and amounts. Never synthesize identity.
    if(rawId===undefined)throw new Error(`${id}: funding invoice missing or invalid ID`);
    const key = `${id}:${marketId}:${rawId}`;
    const side=id==='bybit'&&['Buy','Sell'].includes(raw.side)?raw.side==='Buy'?'long' as const:'short' as const:undefined;
    const quantity=id==='bybit'&&raw.execQty!==undefined&&raw.execQty!==''?numeric(raw.execQty):undefined;
    if(quantity!==undefined&&!(Number.isFinite(quantity)&&quantity>=0))throw new Error('bybit: invalid funding execution quantity');
    if(quantity===0)return;
    const payment:FundingPayment={id:key,timestamp,base:m.base,amountUsd,symbol:m.symbol,...(side?{side}:{}),...(quantity!==undefined?{quantity}:{})};
    const existing=payments.get(key);
    if (existing && (existing.timestamp!==timestamp || existing.amountUsd!==amountUsd||existing.side!==payment.side||existing.quantity!==payment.quantity)) throw new Error(`${id}: inconsistent duplicate funding invoice`);
    payments.set(key,payment);
  };
  if (id==='okx') {
    let cursor:string|undefined;
    for (;;) {
      const response=await fetch(()=>client.privateGetAccountBillsArchive({instType:'SWAP',type:'8',ccy:'USDT',begin:String(since),end:String(until),limit:String(PAGE_SIZE),...(cursor ? {after:cursor} : {})}));
      const rows=response.data;
      if (!Array.isArray(rows)) throw new Error('okx: invalid funding ledger response');
      rows.forEach(add);
      if (rows.length<PAGE_SIZE) break;
      const next=String(rows.at(-1)?.billId ?? '');
      if (!next || next===cursor) throw new Error('okx: funding pagination did not advance');
      cursor=next;
    }
  } else if(id==='bitget'){
    // Classic bills allow <=30-day windows and an idLessThan cursor, up to 100 invoices/page.
    const month=30*86400000;
    for(let start=since;start<=until;start+=month){
      const end=Math.min(start+month-1,until),seen=new Set<string>();let cursor:string|undefined;
      for(;;){
        const data=bitgetData(await fetch(()=>client.privateMixGetV2MixAccountBill({productType:'USDT-FUTURES',businessType:'contract_settle_fee',
          startTime:String(start),endTime:String(end),limit:String(PAGE_SIZE),...(cursor?{idLessThan:cursor}:{})})));
        const rows=data.bills;
        if(!Array.isArray(rows))throw new Error('bitget: invalid funding ledger response');
        rows.forEach(add);
        if(rows.length<PAGE_SIZE)break;
        const next=String(data.endId??rows.at(-1)?.billId??'');
        if(!next||seen.has(next)||next===cursor)throw new Error('bitget: funding pagination did not advance');
        seen.add(next);cursor=next;
      }
    }
  } else if (id==='bybit') {
    // V5 execution history restricts each start/end window to seven days.
    for (let start=since;start<=until;start+=WEEK) {
      const end=Math.min(start+WEEK-1,until);
      let cursor:string|undefined;
      for (;;) {
        const response=await fetch(()=>client.privateGetV5ExecutionList({category:'linear',execType:'Funding',startTime:start,endTime:end,limit:PAGE_SIZE,...(cursor ? {cursor} : {})}));
        const rows=response.result?.list;
        if (!Array.isArray(rows)) throw new Error('bybit: invalid funding ledger response');
        rows.forEach(add);
        const next=response.result?.nextPageCursor;
        if (!next) break;
        if (next===cursor || rows.length===0) throw new Error('bybit: funding pagination did not advance');
        cursor=next;
      }
    }
  } else {
    // Gate uses offset pagination; Binance uses page numbers. Freeze time bounds for the full scan.
    let lastFingerprint='';
    for (let page=0;;page++) {
      const rows=await fetch(()=>id==='binance'
        ? client.fapiPrivateGetIncome({incomeType:'FUNDING_FEE',startTime:since,endTime:until,limit:PAGE_SIZE,page:page+1})
        : client.privateFuturesGetSettleAccountBook({settle:'usdt',type:'fund',from:Math.floor(since/1000),to:Math.ceil(until/1000),limit:PAGE_SIZE,offset:page*PAGE_SIZE}));
      if (!Array.isArray(rows)) throw new Error(`${id}: invalid funding ledger response`);
      rows.forEach(add);
      if (rows.length<PAGE_SIZE) break;
      const fingerprint=JSON.stringify([rows[0],rows.at(-1)]);
      if (fingerprint===lastFingerprint) throw new Error(`${id}: funding pagination did not advance`);
      lastFingerprint=fingerprint;
    }
  }
  assertExchangeRequestActive(client,id);
  return [...payments.values()].sort((a,b)=>a.timestamp-b.timestamp || a.id.localeCompare(b.id));
}
