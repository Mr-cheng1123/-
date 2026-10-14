import type { ManualEntryOperation, ManualEntryState } from '../shared/manual-entry.js';
import { MANUAL_ENTRY_TERMINAL_STATES } from '../shared/manual-entry.js';
import type { JournalOrder,Position } from '../shared/types.js';
import {manualEntryExecutionSummary} from './manual-entry-execution-summary.js';
import {copyEntryExecutionProgress,entryTargetReached} from '../shared/entry-execution-progress.js';

export const MANUAL_ENTRY_QUEUE_MS=5_000;
export const MANUAL_ENTRY_DEADLINE_MS=30_000;
export const MANUAL_ENTRY_LEASE_MS=12_000;
export class ManualEntryCancelled extends Error {}
interface Options {
  now?:()=>number;
  persist:()=>void;
  log:(operation:ManualEntryOperation)=>void;
  positions:()=>Position[];
  orders?:()=>JournalOrder[];
  hasOrderIntent:(positionId:string)=>boolean;
}
/** Only the pre-submission portion is cancellable. Timers never stop an order reconciliation or unwind. */
export class ManualEntryOperations {
  private readonly now:()=>number;
  private timers=new Map<string,ReturnType<typeof setTimeout>>();
  constructor(private readonly records:ManualEntryOperation[],private readonly options:Options){this.now=options.now??Date.now;}
  recover(){
    for(const operation of this.records){
      if(MANUAL_ENTRY_TERMINAL_STATES.has(operation.state))continue;
      const position=this.options.positions().find(p=>p.id===operation.positionId);
      const hasIntent=operation.positionId!==undefined&&this.options.hasOrderIntent(operation.positionId);
      if(operation.ordersSubmitted||hasIntent||position&&[position.long.quantity,position.short.quantity].some(quantity=>quantity>0)){
        operation.ordersSubmitted=true;
        if(position?.status==='open')this.complete(operation.id,position);
        else this.update(operation,'failed','订单提交后进程已中断；保留原订单标识，请核对账户与成交记录',position);
      }else {
        if(position&&position.long.quantity===0&&position.short.quantity===0){
          position.status='closed';position.closedAt=this.now();position.closeReason='服务重启，手动开仓在提交前取消';position.riskReasons=[];
        }
        this.update(operation,'cancelled','服务已重启，本次开仓已取消，未提交订单',position);
      }
    }
  }
  create(id:string,opportunityId:string,expiresAt:number):{operation:ManualEntryOperation;created:boolean}{
    const previous=this.records.find(record=>record.id===id);
    if(previous){if(previous.opportunityId!==opportunityId)throw new Error('同一操作标识不能用于不同机会');return {operation:this.snapshot(previous),created:false};}
    const now=this.now();
    const operation:ManualEntryOperation={id,opportunityId,state:'queued',createdAt:now,updatedAt:now,
      expiresAt:Math.min(now+MANUAL_ENTRY_DEADLINE_MS,expiresAt),leaseExpiresAt:Math.min(now+MANUAL_ENTRY_LEASE_MS,expiresAt),
      message:'已接收开仓请求，等待执行；最多排队 5 秒',cancelable:true,ordersSubmitted:false};
    this.records.unshift(operation);
    if(!Number.isFinite(expiresAt)||expiresAt<=now)this.update(operation,'expired','点击已过期，未提交订单');
    else {this.options.persist();this.options.log(this.snapshot(operation));this.schedule(operation);}
    return {operation:this.snapshot(operation),created:true};
  }
  get(id:string,renew=false):ManualEntryOperation|undefined{
    const operation=this.records.find(record=>record.id===id);if(!operation)return;
    this.expireIfNeeded(operation);
    if(operation.state==='failed'&&operation.ordersSubmitted){
      const position=this.options.positions().find(p=>p.id===operation.positionId);
      if(position&&(position.status==='open'||position.status==='closed')&&position.status!==operation.result?.positionStatus)this.complete(id,position);
    }
    if(renew&&operation.cancelable){operation.leaseExpiresAt=Math.min(operation.expiresAt,this.now()+MANUAL_ENTRY_LEASE_MS);this.schedule(operation);}
    return this.snapshot(operation);
  }
  cancel(id:string,reason='用户取消本次开仓，未提交订单'):ManualEntryOperation|undefined{
    const operation=this.records.find(record=>record.id===id);if(!operation)return;
    this.expireIfNeeded(operation);
    if(operation.cancelable)this.update(operation,'cancelled',reason);
    return this.snapshot(operation);
  }
  begin(id:string){this.ensure(id);this.stage(id,'checking','正在并行核对两腿账户和合约，尚未提交订单');}
  ensure(id:string){
    const operation=this.required(id);this.expireIfNeeded(operation);
    if(operation.ordersSubmitted)return;
    if(!operation.cancelable)throw new ManualEntryCancelled(operation.message);
  }
  stage(id:string,state:'checking'|'preparing',message:string){
    this.ensure(id);const operation=this.required(id);if(operation.ordersSubmitted)return;
    if(operation.state!==state||operation.message!==message)this.update(operation,state,message);
  }
  attachPosition(id:string,position:Position){this.ensure(id);const operation=this.required(id);operation.positionId=position.id;this.options.persist();}
  commit(id:string){
    this.ensure(id);const operation=this.required(id);if(operation.ordersSubmitted)return;
    // No await between this durable transition and Execution's first submission.
    operation.ordersSubmitted=true;this.update(operation,'submitting','先提交空腿，确认成交后按实际数量提交多腿');
  }
  reconciling(id:string){
    const operation=this.required(id);if(!operation.ordersSubmitted||MANUAL_ENTRY_TERMINAL_STATES.has(operation.state))return;
    this.update(operation,'reconciling','空腿回报已收到，正在按成交数量处理多腿');
  }
  complete(id:string,position:Position){
    const operation=this.required(id);
    if(!operation.ordersSubmitted&&MANUAL_ENTRY_TERMINAL_STATES.has(operation.state))return;
    if(position.status==='open'){
      const progress=copyEntryExecutionProgress(position.entryExecution);
      this.update(operation,'completed',progress&&!entryTargetReached(progress)?
        '已保留已确认的部分双腿对冲；原目标尚未补满'+(progress.stopReason?'：'+progress.stopReason:''):
        '双腿已确认成交，已形成对冲持仓',position);
    }
    else if(position.status==='closed')this.update(operation,'failed',!operation.ordersSubmitted?'下单前校验未通过，未提交订单':position.closeReason||'双腿未形成对冲，已撤回已确认成交的残余仓位',position);
    else this.update(operation,'failed','开仓未完成，原订单保留；请核对未确认订单和残余仓位',position);
  }
  fail(id:string,error:string,position?:Position){
    const operation=this.required(id);
    if(!operation.ordersSubmitted&&MANUAL_ENTRY_TERMINAL_STATES.has(operation.state))return;
    this.update(operation,'failed',operation.ordersSubmitted?'提交后处理尚未完成；保留原订单标识，禁止重复提交':'开仓未提交：'+error,position,error);
  }
  stop(){for(const timer of this.timers.values())clearTimeout(timer);this.timers.clear();for(const operation of this.records)if(operation.cancelable)this.update(operation,'cancelled','服务正在停止，本次开仓已取消，未提交订单');}
  private required(id:string){const operation=this.records.find(record=>record.id===id);if(!operation)throw new Error('开仓操作不存在');return operation;}
  private snapshot(operation:ManualEntryOperation):ManualEntryOperation{
    const position=this.options.positions().find(item=>item.id===operation.positionId);
    const result=position?{...operation.result,positionStatus:position.status,base:position.base,longQuantity:position.long.quantity,shortQuantity:position.short.quantity}:operation.result?{...operation.result}:undefined;
    if(result&&position&&this.options.orders)result.executionSummary=manualEntryExecutionSummary(position,this.options.orders(),operation.ordersSubmitted);
    return {...operation,...(result?{result}:{})};
  }
  private expireIfNeeded(operation:ManualEntryOperation){
    if(!operation.cancelable)return;
    const now=this.now();
    if(operation.state==='queued'&&now>=operation.createdAt+MANUAL_ENTRY_QUEUE_MS)this.update(operation,'expired','排队超过 5 秒，本次开仓已取消，未提交订单');
    else if(now>=operation.expiresAt)this.update(operation,'expired','准备超过本次点击有效期，已取消，未提交订单');
    else if(now>=operation.leaseExpiresAt)this.update(operation,'expired','页面未继续确认本次请求，已取消，未提交订单');
  }
  private schedule(operation:ManualEntryOperation){
    const old=this.timers.get(operation.id);if(old)clearTimeout(old);this.timers.delete(operation.id);
    if(!operation.cancelable)return;
    const due=Math.min(operation.expiresAt,operation.leaseExpiresAt,operation.state==='queued'?operation.createdAt+MANUAL_ENTRY_QUEUE_MS:Infinity);
    const timer=setTimeout(()=>{
      this.timers.delete(operation.id);
      // Persist failures must not kill management of existing holdings. The in-memory cancelled state
      // is already set before persistence; commit/create still fail closed if persistence fails there.
      try{this.expireIfNeeded(operation);if(operation.cancelable)this.schedule(operation);}catch{/* No financial action is dispatched by this timer. */}
    },Math.max(1,due-this.now()));
    timer.unref?.();this.timers.set(operation.id,timer);
  }
  private update(operation:ManualEntryOperation,state:ManualEntryState,message:string,position?:Position,error?:string){
    operation.state=state;operation.updatedAt=this.now();operation.message=message;
    operation.cancelable=!operation.ordersSubmitted&&!MANUAL_ENTRY_TERMINAL_STATES.has(state);
    if(position){operation.positionId=position.id;operation.result={positionStatus:position.status,base:position.base,longQuantity:position.long.quantity,shortQuantity:position.short.quantity};}
    if(error)operation.error=error;
    this.options.persist();this.options.log(this.snapshot(operation));this.schedule(operation);
  }
}
