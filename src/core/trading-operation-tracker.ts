import {existsSync,mkdirSync,readFileSync,renameSync,writeFileSync} from 'node:fs';
import {dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import type {JournalOrder,OrderRequest,Position} from '../shared/types.js';
import {conflictingNativeOrderReceipts,hasBoundedOrderQuantity,hasOrderReceiptIdentity,isProvenNoSubmitReceipt,isTerminalOrderReceipt} from '../shared/order-receipt-validity.js';
import {summarizeTradingOperations,tradingOperationCompleteEvidence,type TradingOperation,type TradingOperationKind,
  type TradingOperationProtocol,type TradingOperationQuantities,type TradingOperationStages,type TradingOperationIntervention,
  type TradingOperationsSummary} from '../shared/trading-operations.js';

export interface BeginTradingOperation {
  id?:string;positionId:string;base:string;mode:'live'|'paper';origin:'automatic'|'manual';kind:TradingOperationKind;
  protocol:TradingOperationProtocol;target:TradingOperationQuantities;signalObservedAt?:number;windowEndsAt?:number;
  configDigest?:string;runtimeVersion?:string;
}
export interface TradingOperationTrackerOptions {now?:()=>number;debounceMs?:number;endedLimit?:number;hardLimit?:number}
export interface TrackedTradingOperationsSummary extends TradingOperationsSummary {
  diagnosticError?:string;coverageLimited:boolean;retainedFrom?:number;
}
interface Binding {operationId:string;positionId:string;request:string;exchange:string;symbol:string;clientOrderId:string;side:'long'|'short';submittedAt:number}
const finite=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value);
const quantity=(value:unknown):value is number=>finite(value)&&value>=0;
const same=(a:number,b:number)=>a===0||b===0?a===b:Math.abs(a-b)<=64*Number.EPSILON*Math.max(Math.abs(a),Math.abs(b));
const bounded=(value:unknown,max:number)=>typeof value==='string'?value.replace(/[\u0000-\u001f\u007f]/g,' ').slice(0,max):'';
const safeId=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9_.:-]{1,160}$/.test(value);
const key=(order:JournalOrder)=>JSON.stringify([order.exchange,order.request.symbol,order.request.clientOrderId]);
const requestProof=(request:OrderRequest)=>JSON.stringify(request);
const active=(row:TradingOperation)=>!row.endedAt&&['running','partial','unknown'].includes(row.state);

/** Diagnostic-only sidecar. It cannot place orders, save financial state, or restore execution permission. */
export class TradingOperationTracker {
  readonly path:string;
  private readonly now:()=>number;private readonly debounceMs:number;private readonly endedLimit:number;private readonly hardLimit:number;
  private readonly rows=new Map<string,TradingOperation>();private readonly currentIds=new Map<string,string>();
  private readonly sessionIds=new Set<string>();
  private readonly bindings=new Map<string,Binding>();private timer:ReturnType<typeof setTimeout>|undefined;
  private readonly bindingsByPosition=new Map<string,Set<string>>();
  private dirty=false;private readBlocked=false;private limited=false;private diagnosticError:string|undefined;
  constructor(storePath:string,options:TradingOperationTrackerOptions={}){
    this.path=storePath+'.operations.json';this.now=options.now??Date.now;
    this.debounceMs=Math.max(0,options.debounceMs??1000);this.endedLimit=Math.max(0,Math.floor(options.endedLimit??1000));
    this.hardLimit=Math.max(1,Math.floor(options.hardLimit??5000));this.load();
  }
  private load():void {
    try {
      if(!existsSync(this.path))return;
      const source=JSON.parse(readFileSync(this.path,'utf8')) as {version?:unknown;operations?:unknown;coverageLimited?:unknown};
      if(source.version!==1||!Array.isArray(source.operations)||source.operations.length>100_000)throw new Error('invalid sidecar');
      const summary=summarizeTradingOperations(source.operations,this.now());
      if(summary.counts.invalid||summary.counts.duplicateIds)throw new Error('invalid operation evidence');
      this.limited=source.coverageLimited===true;
      for(const value of summary.rows){
        const row=structuredClone(value);
        if(active(row)){row.state='unknown';row.waitReason={code:'process-interrupted',text:'原进程操作尚未完成；当前仅保留历史观察，未恢复执行'};}
        this.rows.set(row.id,row);
      }
      // Neither current IDs nor order bindings are reconstructed from disk.
      this.trim();
    }catch{this.readBlocked=true;this.diagnosticError='操作统计文件无法完整校验，已保留原文件；当前统计仅覆盖本进程新观察';this.limited=true;}
  }
  private changed(row?:TradingOperation):void {
    if(row)row.updatedAt=this.now();this.dirty=true;
    if(!this.timer){this.timer=setTimeout(()=>{this.timer=undefined;this.flush();},this.debounceMs);this.timer.unref();}
  }
  private trim():void {
    const ended=[...this.rows.values()].filter(row=>!!row.endedAt&&['complete','partial','cancelled','failed'].includes(row.state)).sort((a,b)=>b.endedAt!-a.endedAt!);
    for(const row of ended.slice(this.endedLimit)){
      this.rows.delete(row.id);this.sessionIds.delete(row.id);this.limited=true;
      if(this.currentIds.get(row.positionId)===row.id)this.currentIds.delete(row.positionId);
      for(const orderKey of this.bindingsByPosition.get(row.positionId)??[]){
        const binding=this.bindings.get(orderKey);if(binding?.operationId!==row.id)continue;
        this.bindings.delete(orderKey);this.bindingsByPosition.get(row.positionId)?.delete(orderKey);
      }
      if(this.bindingsByPosition.get(row.positionId)?.size===0)this.bindingsByPosition.delete(row.positionId);
    }
    // Unfinished records are never silently discarded. New records are refused at the hard cap.
    if(this.rows.size>=this.hardLimit)this.limited=true;
  }
  private raw(id:string):TradingOperation|undefined{return this.rows.get(id);}
  private reason(code:string,text:string):{code:string;text:string}{return {code:safeId(code)?code:'operation-wait',text:bounded(text,200)};}
  private firstStage(row:TradingOperation,stage:keyof TradingOperationStages,at:number):void {
    if(finite(at)&&at>=row.startedAt&&at<=this.now()&&row.stages[stage]===undefined)row.stages[stage]=at;
  }
  begin(input:BeginTradingOperation):TradingOperation|undefined {
    const existing=this.current(input.positionId);
    if(input.origin==='automatic'&&existing&&existing.origin==='automatic'&&active(existing)&&
      (input.kind==='entry'?existing.kind==='entry':existing.kind!=='entry'))return existing;
    this.trim();
    if(this.rows.size>=this.hardLimit){this.limited=true;this.diagnosticError='操作统计保留容量已满，新操作暂缺统计；未改变交易权限';return;}
    const at=this.now(),id=input.id??randomUUID();
    if(this.rows.has(id)){this.diagnosticError='操作统计身份重复，未覆盖原记录';return;}
    const row:TradingOperation={version:1,id,positionId:input.positionId,base:input.base,mode:input.mode,origin:input.origin,
      kind:input.kind,protocol:input.protocol,state:'running',startedAt:at,updatedAt:at,target:structuredClone(input.target),
      confirmed:{long:0,short:0},remaining:structuredClone(input.target),stages:{},
      attempts:{preflightNotSent:0,zeroFill:0,unknown:0,submitted:0,pending:0},
      ...(input.windowEndsAt!==undefined?{windowEndsAt:input.windowEndsAt}:{}),
      ...(input.configDigest?{configDigest:bounded(input.configDigest,160)}:{}),...(input.runtimeVersion?{runtimeVersion:bounded(input.runtimeVersion,160)}:{})};
    if(finite(input.signalObservedAt)&&input.signalObservedAt>0&&input.signalObservedAt<=at){row.startedAt=input.signalObservedAt;row.stages.signalObservedAt=input.signalObservedAt;}
    if(summarizeTradingOperations([row],at).counts.invalid){this.diagnosticError='操作统计输入不完整，未创建无效记录';return;}
    this.rows.set(id,row);this.sessionIds.add(id);this.currentIds.set(input.positionId,id);this.changed(row);return structuredClone(row);
  }
  attach(id:string,positionId:string,target?:TradingOperationQuantities):void {
    const row=this.raw(id);if(!row||!safeId(positionId)||!active(row))return;
    const hasBoundOrders=[...(this.bindingsByPosition.get(row.positionId)??[])].some(key=>this.bindings.get(key)?.operationId===id);
    if(row.positionId!==positionId&&hasBoundOrders)return;
    if(this.currentIds.get(row.positionId)===id)this.currentIds.delete(row.positionId);
    row.positionId=positionId;this.currentIds.set(positionId,id);
    if(target&&!hasBoundOrders&&
      ['long','short'].every(side=>{const value=target[side as keyof TradingOperationQuantities];return value===null||quantity(value);})){
      row.target=structuredClone(target);row.remaining=structuredClone(target);
    }
    this.changed(row);
  }
  current(positionId:string):TradingOperation|undefined {
    const id=this.currentIds.get(positionId),row=id?this.raw(id):undefined;return row&&active(row)?structuredClone(row):undefined;
  }
  /** A single diagnostic record without computing aggregate statistics. */
  get(id:string):TradingOperation|undefined {const row=this.raw(id);return row?structuredClone(row):undefined;}
  /** Only this process owns the bindings needed to confirm an unfinished operation. */
  activeRows():TradingOperation[] {
    const result:TradingOperation[]=[];
    for(const id of this.sessionIds){const row=this.raw(id);if(row&&active(row))result.push(structuredClone(row));}
    return result;
  }
  stage(id:string,stage:keyof TradingOperationStages,at=this.now(),waitReason?:{code:string;text:string}):void {
    const row=this.raw(id);if(!row||!active(row))return;this.firstStage(row,stage,at);
    if(waitReason)row.waitReason=this.reason(waitReason.code,waitReason.text);this.changed(row);
  }
  wait(id:string,code:string,text:string):void {const row=this.raw(id);if(!row||!active(row))return;row.waitReason=this.reason(code,text);this.changed(row);}
  /** Set only when the real manual processing window starts. This is not a timeout or an execution permit. */
  window(id:string,endsAt:number):void {
    const row=this.raw(id);if(!row||!active(row)||!finite(endsAt)||endsAt<row.startedAt)return;
    row.windowEndsAt=endsAt;this.changed(row);
  }
  attemptNotSent(id:string,code:string,text:string):void {
    const row=this.raw(id);if(!row||!active(row))return;row.attempts.preflightNotSent++;row.waitReason=this.reason(code,text);this.changed(row);
  }
  orderSubmitted(position:Position,journal:JournalOrder):void {
    const request=journal?.request;if(!request||journal.positionId!==position.id||request.base!==position.base)return;
    const parentId=journal.executionEvidence?.makerCloseParentClientId;
    const parent=parentId?[...(this.bindingsByPosition.get(position.id)??[])].map(key=>this.bindings.get(key)!)
      .find(binding=>binding.clientOrderId===parentId):undefined;
    const opId=parent?.operationId??this.currentIds.get(position.id),row=opId?this.raw(opId):undefined;
    if(!row||!active(row)||journal.createdAt<row.startedAt||!safeId(request.clientOrderId))return;
    const matches=(['long','short'] as const).filter(side=>position[side]?.exchange===journal.exchange&&position[side].symbol===request.symbol&&
      request.side===(side==='long'?(request.reduceOnly?'sell':'buy'):(request.reduceOnly?'buy':'sell')));
    if(matches.length!==1||row.kind!=='entry'&&!request.reduceOnly)return;
    const orderKey=key(journal),prior=this.bindings.get(orderKey);
    if(prior){if(prior.operationId!==row.id||prior.request!==requestProof(request)){
      row.state='unknown';row.waitReason=this.reason('order-binding-conflict','原下单身份或请求变化，操作统计等待核对');this.changed(row);
    }return;}
    const at=this.now();this.bindings.set(orderKey,{operationId:row.id,positionId:position.id,request:requestProof(request),exchange:journal.exchange,
      symbol:request.symbol,clientOrderId:request.clientOrderId,side:matches[0],submittedAt:at});
    const positionBindings=this.bindingsByPosition.get(position.id)??new Set<string>();positionBindings.add(orderKey);this.bindingsByPosition.set(position.id,positionBindings);
    row.attempts.submitted++;this.firstStage(row,'submittedAt',at);this.changed(row);
  }
  observe(position:Position,orders:readonly JournalOrder[]):void {
    const relevant=[...(this.bindingsByPosition.get(position.id)??[])].map(key=>this.bindings.get(key)!).filter(binding=>{
      const row=this.raw(binding.operationId);return !!row&&active(row);
    });
    if(!relevant.length)return;
    const groups=new Map<string,Binding[]>();for(const binding of relevant){const group=groups.get(binding.operationId)??[];group.push(binding);groups.set(binding.operationId,group);}
    const conflicts=conflictingNativeOrderReceipts(orders),at=this.now(),selectedOrders=new Map<string,JournalOrder[]>();
    for(const order of orders)if(order.positionId===position.id&&order.request){
      const orderKey=key(order);if(!this.bindingsByPosition.get(position.id)?.has(orderKey))continue;
      const matches=selectedOrders.get(orderKey)??[];matches.push(order);selectedOrders.set(orderKey,matches);
    }
    for(const [operationId,bindings] of groups){
      const row=this.raw(operationId);if(!row||!active(row))continue;
      const before=JSON.stringify(row),confirmed={long:0,short:0},unresolvedSide={long:false,short:false};
      let unresolved=0,pending=0,awaitingReceipt=0,zero=0,noSend=0,hasFill=false;
      for(const binding of bindings){
        const found=selectedOrders.get(JSON.stringify([binding.exchange,binding.symbol,binding.clientOrderId]))??[];
        const order=found.length===1?found[0]:undefined,result=order?.result;
        const intact=!!order&&!conflicts.has(order)&&requestProof(order.request)===binding.request;
        if(intact&&result===undefined&&!order.error&&position.status!=='attention'){
          pending++;awaitingReceipt++;continue;
        }
        const maker=order?.makerReduction;
        const awaitingFirstMakerInspection=!!order&&!!maker&&maker.activity==='unknown'&&order.request.postOnly===true&&
          finite(maker.acknowledgedAt)&&maker.acknowledgedAt>=binding.submittedAt&&maker.acknowledgedAt<=at&&
          maker.lastObservedAt===undefined&&maker.stopReason===undefined&&!order.error&&position.status!=='attention'&&
          result?.id!==order.request.clientOrderId;
        if(intact&&(maker?.activity==='active'||awaitingFirstMakerInspection)&&
          hasOrderReceiptIdentity(order.request,result)&&!!result.id&&hasBoundedOrderQuantity(order.request,result)){
          pending++;
          if(finite(maker?.acknowledgedAt))this.firstStage(row,'acknowledgedAt',maker.acknowledgedAt);
          if(finite(maker?.firstFillObservedAt))this.firstStage(row,'firstFillObservedAt',maker.firstFillObservedAt);
          continue;
        }
        if(!order||conflicts.has(order)||requestProof(order.request)!==binding.request||!result||
          !isTerminalOrderReceipt(order.request,result)||order.makerReduction&&order.makerReduction.activity!=='terminal'||
          !finite(result.feeUsd)||result.filledQuantity>0&&(!finite(result.averagePrice)||result.averagePrice<=0||result.averagePriceVerified===false)){
          unresolved++;unresolvedSide[binding.side]=true;continue;
        }
        if(isProvenNoSubmitReceipt(order.request,result)){noSend++;continue;}
        const observed=order.execution?.confirmedAt;
        // This is local confirmation of a native receipt, not exchange receipt/HTTP timing.
        // Paper/client-ID stand-ins and unresolved results cannot supply this evidence.
        if(result.id!==order.request.clientOrderId&&finite(observed)&&observed>=binding.submittedAt&&observed<=at)
          this.firstStage(row,'acknowledgedAt',observed);
        if(result.filledQuantity===0){zero++;continue;}
        hasFill=true;confirmed[binding.side]+=result.filledQuantity*(row.kind==='entry'&&order.request.reduceOnly?-1:1);
        if(finite(observed)&&observed>=binding.submittedAt&&observed<=at)this.firstStage(row,'firstFillObservedAt',observed);
        if(maker){
          if(finite(maker.acknowledgedAt))this.firstStage(row,'acknowledgedAt',maker.acknowledgedAt);
          if(finite(maker.firstFillObservedAt))this.firstStage(row,'firstFillObservedAt',maker.firstFillObservedAt);
        }
      }
      row.attempts.unknown=unresolved;row.attempts.pending=pending;row.attempts.zeroFill=zero;
      // The observed subset is recomputed; explicit no-send preflights are retained separately by monotonic max.
      row.attempts.preflightNotSent=Math.max(row.attempts.preflightNotSent,noSend);
      for(const side of ['long','short'] as const){
        // A terminal prefix cannot establish a leg's total while any bound request remains unknown.
        if(unresolvedSide[side]){row.confirmed[side]=null;row.remaining[side]=null;continue;}
        const target=row.target[side],value=confirmed[side];row.confirmed[side]=quantity(value)?value:null;
        row.remaining[side]=target!==null&&quantity(value)&&(value<=target||same(value,target))?
          same(target,value)?0:Math.max(0,target-value):null;
      }
      const filledTargets=row.remaining.long===0&&row.remaining.short===0&&row.confirmed.long!==null&&row.confirmed.short!==null;
      if(unresolved){row.state='unknown';row.waitReason=this.reason('order-result-unknown','本次操作原订单结果仍待确认');}
      else if(pending){row.state=hasFill?'partial':'running';row.waitReason=awaitingReceipt?
        this.reason('order-call-pending','本次下单适配器调用仍在进行，等待原请求回执'):
        this.reason('maker-order-working','原 Maker 已确认在途，正在等待成交或最终回执');}
      else if(filledTargets){row.state='partial';this.firstStage(row,'pairedAt',at);row.waitReason=this.reason('account-confirmation','目标成交已确认，等待账户数量核对');}
      else if(hasFill){row.state='partial';row.waitReason=this.reason('remaining-quantity','本次操作仍有剩余数量，等待继续处理');}
      else{row.state='running';row.waitReason=this.reason('no-confirmed-fill','本次操作尚未确认成交');}
      if(JSON.stringify(row)!==before)this.changed(row);
    }
  }
  end(id:string,state:'partial'|'cancelled'|'failed'|'unknown',reason?:{code:string;text:string}):void {
    const row=this.raw(id);if(!row||!active(row))return;row.state=state;
    if(state!=='unknown'){row.endedAt=this.now();this.sessionIds.delete(id);}
    if(reason)row.waitReason=this.reason(reason.code,reason.text);this.trim();this.changed(row);
  }
  /** The caller must independently verify both selected account quantities; this method supplies no such proof. */
  confirm(id:string,at:number):boolean {
    const row=this.raw(id);if(!row||!this.sessionIds.has(id)||!active(row)||!finite(at)||at>this.now()||
      !finite(row.stages.pairedAt)||at<row.stages.pairedAt)return false;
    const candidate=structuredClone(row);candidate.state='complete';candidate.stages.accountConfirmedAt=at;
    candidate.endedAt=this.now();candidate.updatedAt=this.now();
    if(!tradingOperationCompleteEvidence(candidate,this.now()))return false;
    delete candidate.waitReason;this.rows.set(id,candidate);this.sessionIds.delete(id);this.trim();this.changed(candidate);return true;
  }
  intervene(id:string,kind:TradingOperationIntervention['kind'],evidenceId:string,at=this.now()):void {
    const row=this.raw(id);if(!row||row.origin!=='automatic'||row.intervention||!safeId(evidenceId)||!finite(at)||at<row.startedAt||at>this.now())return;
    row.intervention={kind,evidenceId,requiredAt:at};this.changed(row);
  }
  snapshot(now=this.now()):TrackedTradingOperationsSummary {
    const summary=summarizeTradingOperations([...this.rows.values()],now);
    return {...summary,coverageLimited:this.limited,...(this.diagnosticError?{diagnosticError:this.diagnosticError}:{}),
      ...(summary.rows.length?{retainedFrom:Math.min(...summary.rows.map(row=>row.startedAt))}:{})};
  }
  flush():void {
    if(this.timer){clearTimeout(this.timer);this.timer=undefined;}if(!this.dirty)return;
    if(this.readBlocked)return;
    try {
      mkdirSync(dirname(this.path),{recursive:true});const temporary=this.path+'.tmp';
      writeFileSync(temporary,JSON.stringify({version:1,operations:[...this.rows.values()],coverageLimited:this.limited}),{encoding:'utf8',mode:0o600});
      renameSync(temporary,this.path);this.dirty=false;this.diagnosticError=undefined;
    }catch{this.diagnosticError='操作统计文件写入失败，当前统计尚未保存；交易账本未由本功能更改';}
  }
  dispose():void {this.flush();if(this.timer){clearTimeout(this.timer);this.timer=undefined;}}
}
