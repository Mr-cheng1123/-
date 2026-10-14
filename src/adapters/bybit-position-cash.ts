import type {AccountPosition} from '../shared/types.js';

interface Holding {symbol:string;side:'Buy'|'Sell';quantity:number;openTime:number;key:string}
interface Cash {fundingUsd:number;feesUsd:number;cashFlowAt:number;cashFlowSince:number;realizedPnlUsd?:number}
type GetLog=(params:Record<string,unknown>)=>Promise<any>;
const DAY=86_400_000,WINDOW=7*DAY,REFRESH_MS=30_000,MAX_AGE_MS=90_000;
const CASH_REASONS={
  loading:'正在读取当前持仓周期账单',ready:'账单已完整核对',incomplete:'账单无法完整归属当前持仓周期',
  error:'账单请求失败，后台会自动重试',unavailable:'交易所未返回当前持仓周期时间',stale:'账单证据已过期，等待重新读取',
} as const;
function numeric(value:unknown):number{return typeof value==='number'||typeof value==='string'&&value.trim()!==''?Number(value):NaN;}
function noExtraFees(value:unknown):boolean {
  if(value===undefined||value==='')return true;
  if(Array.isArray(value))return value.length===0;
  if(typeof value!=='string'||value.length>4096)return false;
  try{const parsed=JSON.parse(value);return Array.isArray(parsed)&&parsed.length===0;}catch{return false;}
}
function holding(raw:any,now:number):Holding|undefined{
  const quantity=numeric(raw?.size),openTime=numeric(raw?.openTime),idx=numeric(raw?.positionIdx);
  // createdTime is the first ever position on this contract, not the current opening time.
  if(typeof raw?.symbol!=='string'||!raw.symbol||!['Buy','Sell'].includes(raw.side)||![0,1,2].includes(idx)||
    !(quantity>0&&Number.isFinite(quantity)&&Number.isSafeInteger(openTime)&&openTime>0&&openTime<=now&&now-openTime<730*DAY))return;
  return {symbol:raw.symbol,side:raw.side,quantity,openTime,
    // Settings/sequence updates do not identify a new cash cycle. Quantities and the
    // actual opening time still invalidate cash, without re-dating valid evidence.
    key:JSON.stringify([raw.symbol,idx,raw.side,quantity,openTime])};
}

/** Current-cycle actual cash from UTA transaction logs, independent of order execution.
 * https://bybit-exchange.github.io/docs/v5/account/transaction-log
 * funding is signed income; fee is signed expense (negative is a rebate).
 */
export function summarizeBybitPositionCash(h:Holding,rows:any[],asOf:number):Cash|undefined{
  let fundingUsd=0,feesUsd=0,quantity=0,openingSeen=false,realizedPnlUsd=0,realizedComplete=true;
  const sign=h.side==='Buy'?1:-1;
  for(const row of rows){
    if(row?.symbol!==h.symbol)continue;
    const at=numeric(row.transactionTime);
    if(!Number.isSafeInteger(at))return;
    if(at<h.openTime||at>asOf)continue;
    if(row.category!=='linear'||row.currency!=='USDT')return;
    // A moved position does not prove this account opened an ordinary trade cycle.
    // Native linear logs normally have empty subtypes/extraFees; do not drop supplied financial evidence.
    if(row.transSubType!==undefined&&row.transSubType!==''||!noExtraFees(row.extraFees))return;
    if(row.type==='SETTLEMENT'){
      if(row.side!==h.side)continue;
      const funding=numeric(row.funding),size=numeric(row.size);
      if(!Number.isFinite(funding)||!Number.isFinite(size)||size*sign<=0)return;
      fundingUsd+=funding;
    }else if(row.type==='TRADE'){
      const qty=numeric(row.qty),after=numeric(row.size),fee=numeric(row.fee);
      if(!['Buy','Sell'].includes(row.side)||!(qty>0&&Number.isFinite(qty))||!Number.isFinite(after)||!Number.isFinite(fee))return;
      const delta=(row.side==='Buy'?1:-1)*qty,before=after-delta;
      // Signed post-trade size identifies the hedge leg even when a Buy partially closes a short.
      if(after*sign<0||after===0&&before*sign<=0)continue;
      // A one-way reversal includes the old closing part: allocate only the new opening quantity/fee.
      const opensFromOpposite=before*sign<0;
      const ownedDelta=opensFromOpposite?after:delta;
      if(at===h.openTime&&ownedDelta*sign>0)openingSeen=true;
      quantity+=ownedDelta*sign;
      feesUsd+=fee*(opensFromOpposite?Math.abs(after)/qty:1);
      // TRADE.cashFlow is pure realized price PnL. A one-way reversal closes the previous cycle;
      // its closing PnL does not belong to the newly opened remainder.
      if(!opensFromOpposite){const cashFlow=numeric(row.cashFlow);if(Number.isFinite(cashFlow))realizedPnlUsd+=cashFlow;else realizedComplete=false;}
    }else if(numeric(row.funding)!==0||numeric(row.fee)!==0){
      // Position moves or unrecognised financial events need their own attribution rules.
      return;
    }
  }
  // Empty, delayed or incomplete history must never fabricate zero funding/fees.
  if(!openingSeen||Math.abs(quantity-h.quantity)>Math.max(1e-9,h.quantity*1e-9)||![fundingUsd,feesUsd].every(Number.isFinite))return;
  return {fundingUsd,feesUsd,cashFlowAt:asOf,cashFlowSince:h.openTime,...(realizedComplete?{realizedPnlUsd}:{})};
}

/** Starts background GETs; slow/paginated cash history never delays fresh quantities or trading checks. */
export class BybitPositionCash {
  private values=new Map<string,Cash>();private pending?:Promise<void>;private stopped=false;
  private outcomes=new Map<string,'incomplete'|'error'>();
  private currentKeys=new Set<string>();
  private attemptedAt=-Infinity;private attemptedKey='';
  private lastError?:string;
  constructor(private getLog:GetLog,private now:()=>number=Date.now){}
  enrich(rawRows:any[],positions:AccountPosition[]):AccountPosition[]{
    const now=this.now(),holdings=rawRows.map(row=>holding(row,now)).filter((h):h is Holding=>!!h);
    this.currentKeys=new Set(holdings.map(h=>h.key));
    // A changed quantity/cycle cannot resurrect cash retained for an earlier snapshot.
    for(const key of this.values.keys())if(!this.currentKeys.has(key))this.values.delete(key);
    for(const key of this.outcomes.keys())if(!this.currentKeys.has(key))this.outcomes.delete(key);
    const key=holdings.map(h=>h.key).sort().join('|');
    if(!this.stopped&&!this.pending&&holdings.length&&(key!==this.attemptedKey||now-this.attemptedAt>=REFRESH_MS)){
      this.attemptedAt=now;this.attemptedKey=key;
      this.pending=this.collect(holdings,now).then(rows=>{
        if(this.stopped)return;
        const values=new Map<string,Cash>(),outcomes=new Map<string,'incomplete'|'error'>(),completedAt=this.now();
        for(const h of holdings){
          if(!this.currentKeys.has(h.key))continue;
          const cash=summarizeBybitPositionCash(h,rows,now);
          if(cash)values.set(h.key,cash);else {
            outcomes.set(h.key,'incomplete');
            // A delayed/incomplete history is not evidence that previously verified
            // cash disappeared. Keep only the same holding's unexpired observation.
            const prior=this.values.get(h.key);
            if(prior&&completedAt>=prior.cashFlowAt&&completedAt-prior.cashFlowAt<=MAX_AGE_MS)values.set(h.key,prior);
          }
        }
        this.values=values;
        this.outcomes=outcomes;
        this.lastError=undefined;
      }).catch(error=>{
        if(this.stopped)return;
        for(const h of holdings)if(this.currentKeys.has(h.key))this.outcomes.set(h.key,'error');
        this.lastError=error instanceof Error&&error.message.startsWith('Bybit cash history ')?error.message:'Bybit cash history request failed';
      })
        .finally(()=>{this.pending=undefined;});
    }
    return positions.map(p=>{
      const h=holdings.find(h=>h.symbol===p.symbol.replace('/USDT:USDT','USDT')&&h.side===(p.side==='long'?'Buy':'Sell'));
      const cash=h&&this.values.get(h.key);
      const positioned=h?{...p,positionOpenedAt:h.openTime}:p;
      const valid=!!cash&&now>=cash.cashFlowAt&&now-cash.cashFlowAt<=MAX_AGE_MS;
      const outcome=h&&this.outcomes.get(h.key);
      const cashFlowStatus:AccountPosition['cashFlowStatus']=valid?(outcome==='incomplete'||!Number.isFinite(cash!.realizedPnlUsd)?'incomplete':'ready'):
        !h?'unavailable':outcome==='error'?'error':cash?'stale':outcome??'loading';
      return {...positioned,...(valid?cash:{}),cashFlowStatus,cashFlowReason:CASH_REASONS[cashFlowStatus]};
    });
  }
  private async collect(holdings:Holding[],asOf:number):Promise<any[]>{
    const rows:any[]=[],ids=new Map<string,string>();let requests=0;
    for(let start=Math.min(...holdings.map(h=>h.openTime));start<=asOf;start+=WINDOW){
      const end=Math.min(asOf,start+WINDOW-1),cursors=new Set<string>();let cursor:string|undefined;
      do{
        if(this.stopped||++requests>240)throw new Error('Bybit cash history incomplete');
        const response=await this.getLog({accountType:'UNIFIED',category:'linear',currency:'USDT',startTime:start,endTime:end,limit:50,...(cursor?{cursor}:{})});
        const result=response?.result;
        if(response?.retCode!==0||!Array.isArray(result?.list))throw new Error('Bybit cash history unavailable');
        for(const row of result.list){
          if(typeof row?.id!=='string'||!row.id)throw new Error('Bybit cash history identity missing');
          const at=numeric(row.transactionTime);if(!Number.isSafeInteger(at)||at<start||at>end)throw new Error('Bybit cash history outside requested window');
          const value=JSON.stringify([row.symbol,row.type,row.transSubType,row.side,row.transactionTime,row.funding,row.fee,row.cashFlow,row.qty,row.size,row.category,row.currency,row.extraFees]);
          const previous=ids.get(row.id);if(previous&&previous!==value)throw new Error('Bybit cash history duplicate conflict');
          if(!previous){ids.set(row.id,value);rows.push(row);}
        }
        const next=result.nextPageCursor;
        if(next===''||next===undefined||next===null)break;
        if(typeof next!=='string'||!result.list.length||cursors.has(next))throw new Error('Bybit cash history pagination stalled');
        cursors.add(next);cursor=next;
      }while(true);
    }
    return rows;
  }
  stop(){this.stopped=true;this.values.clear();this.outcomes.clear();this.currentKeys.clear();}
  status(){return {pending:!!this.pending,available:this.values.size,error:this.lastError};}
}
