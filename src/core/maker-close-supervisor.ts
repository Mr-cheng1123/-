import type {MakerReductionObservation,OrderResult} from '../shared/types.js';

export const MAKER_CLOSE_TIMEOUT_MS=5_000;
export const MAKER_CLOSE_POLL_MS=100;
export interface MakerCloseCallbacks {
  submit:()=>Promise<OrderResult>;
  acknowledge:(result:OrderResult|undefined)=>Promise<void>;
  inspect:()=>Promise<MakerReductionObservation>;
  /** Commits verified cumulative cash and immediately hedges the newly confirmed excess. */
  observe:(observation:MakerReductionObservation)=>Promise<{terminal:boolean;stopReason?:string}>;
  canRest:()=>Promise<boolean>;
  cancel:()=>Promise<void>;
  finish:(reason:string)=>Promise<void>;
  failed?:(error:unknown)=>void;
  /** Notification only, after the original session has left the registry. */
  settled?:()=>void;
}
interface Session {reason?:string;task:Promise<void>;wake?:()=>void}
interface Clock {now:()=>number;wait:(ms:number)=>Promise<void>}
const clock:Clock={now:()=>Date.now(),wait:ms=>new Promise(resolve=>setTimeout(resolve,ms))};

/** Exchange waits run outside the engine queue. Only callback commits and one bounded IOC hedge use it. */
export class MakerCloseSupervisor {
  private readonly sessions=new Map<string,Session>();
  constructor(private readonly time:Clock=clock){}
  has(id:string):boolean{return this.sessions.has(id);}
  requestStop(id:string,reason='停止本轮 Maker 挂单'):void {const session=this.sessions.get(id);if(session){session.reason??=reason;session.wake?.();}}
  async drain():Promise<void>{for(const id of this.sessions.keys())this.requestStop(id,'软件停止，撤销原 Maker 余单并核对最终成交');await Promise.allSettled([...this.sessions.values()].map(session=>session.task));}
  start(id:string,deadlineAt:number,callbacks:MakerCloseCallbacks):boolean {
    if(this.sessions.has(id))return false;
    const session:Session={task:Promise.resolve()};this.sessions.set(id,session);
    // Starting a supervisor never waits inside the caller's engine.exclusive transaction.
    session.task=Promise.resolve().then(()=>this.run(session,deadlineAt,callbacks)).finally(()=>{
      this.sessions.delete(id);
      try{callbacks.settled?.();}catch{/* Scheduling cannot grant financial permission. */}
    });
    // Keep a rejected task observable to wait/drain, while avoiding an unattended process rejection.
    void session.task.catch(error=>{try{callbacks.failed?.(error);}catch{/* A failed persistence handler cannot authorize a new action. */}});
    return true;
  }
  async settled(id:string):Promise<void>{await this.sessions.get(id)?.task;}
  private async run(session:Session,deadlineAt:number,c:MakerCloseCallbacks):Promise<void>{
    let cancelled=false,acknowledged=false,finalReads=0,lastVerifiedFill=0,reason='Maker 本批已完成，后续批次重新核验净收益率';
    let resolveSafety!:()=>void,cancelTask:Promise<void>|undefined;
    const safety=new Promise<undefined>(resolve=>{resolveSafety=()=>resolve(undefined);});
    const cancel=()=>{
      if(cancelled)return;
      cancelled=true;reason=session.reason??reason;
      cancelTask=Promise.resolve().then(()=>c.cancel()).catch(()=>undefined);
    };
    session.wake=()=>{resolveSafety();if(acknowledged)cancel();};
    const timer=setTimeout(()=>{session.reason??='Maker 挂单超过 5 秒，撤销余单并核对最终累计成交';session.wake?.();},Math.max(0,deadlineAt-this.time.now()));
    const finalInspection=async()=>{
      let limit:ReturnType<typeof setTimeout>|undefined;
      try{return await Promise.race([c.inspect(),new Promise<undefined>(resolve=>{limit=setTimeout(()=>resolve(undefined),5_000);})]);}
      finally{if(limit)clearTimeout(limit);}
    };
    try{
      let acknowledgement:OrderResult|undefined;
      try{acknowledgement=await c.submit();}catch{session.reason='原 Maker 提交结果待核对，未重发';}
      acknowledged=true;
      await c.acknowledge(acknowledgement);
      if(session.reason)cancel();
      for(;;){
        if(!session.reason&&this.time.now()>=deadlineAt)session.reason='Maker 挂单超过 5 秒，撤销余单并核对最终累计成交';
        if(!session.reason&&!await Promise.race([c.canRest(),safety]))session.reason??='净收益率、盘口或交易许可已变化，撤销原 Maker 余单';
        if(session.reason&&!cancelled){
          cancel();
          // A cancel ACK does not establish inactivity. Always inspect the original order afterward.
        }
        if(cancelled)await cancelTask;
        let observation:MakerReductionObservation;
        try{
          const next=cancelled?await finalInspection():await Promise.race([c.inspect(),safety]);
          if(!next){session.reason??='原 Maker 读取超过处理窗口，核对撤单终态';if(cancelled&&++finalReads>=3)break;continue;}
          observation=next;
        }
        catch{session.reason??='原 Maker 订单读取失败，撤销余单后等待对账';if(cancelled&&++finalReads>=3)break;continue;}
        const outcome=await c.observe(observation);
        if(outcome.terminal){reason=session.reason??reason;break;}
        if(outcome.stopReason)session.reason??=outcome.stopReason;
        if(observation.activity==='unknown')session.reason??='原 Maker 活动状态或成交证据未确认，停止新增批次';
        if(cancelled&&++finalReads>=3){reason='撤单后原 Maker 终态尚未确认，保留原 ID 等待对账，禁止重挂';break;}
        // Only a verified cumulative increase, after observe has committed and completed its hedge,
        // removes the idle delay. Duplicate/zero receipts keep the bounded polling interval.
        const filled=observation.result.filledQuantity,progress=observation.executionVerified&&
          observation.activity!=='unknown'&&Number.isFinite(filled)&&filled>lastVerifiedFill;
        if(progress)lastVerifiedFill=filled;
        if(session.reason||progress)continue;
        await Promise.race([this.time.wait(MAKER_CLOSE_POLL_MS),safety]);
      }
    }catch{
      reason='Maker 成交或对侧减仓处理未完成，保留原订单与已确认账本等待核对';
      // Processing errors cannot leave an acknowledged resting remainder intentionally unmanaged.
      session.reason??=reason;cancel();await cancelTask;
      for(let attempt=0;attempt<3;attempt++)try{
        const final=await finalInspection();if(!final)break;
        const outcome=await c.observe(final);if(outcome.terminal)break;
      }catch{break;}
    }finally{
      clearTimeout(timer);session.wake=undefined;
    }
    await c.finish(reason);
  }
}
