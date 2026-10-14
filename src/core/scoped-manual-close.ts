import type {AccountPosition,AccountState,AppConfig,ExchangeAdapter,ExchangeId,MarketSnapshot,OrderRequest,Position,PositionLeg} from '../shared/types.js';
import type {SelectedManualCloseLeg} from './manual-close-selection.js';
import type {ManualCloseOperation} from '../shared/manual-close.js';
import {Execution} from './execution.js';
import type {Store} from './store.js';
import {quoteIsFresh} from './market-validity.js';
import {quoteSkewMs} from './strategy.js';
import {MAX_BEST_PRICE_CLOSE_MS} from './close-batch.js';
import {quantityAdd,quantitySubtract} from './order-quantity.js';
import {isCurrentUnconfirmedOrder} from '../shared/ledger-lifecycle.js';

declare module './store.js' {interface SavedState {manualCloseOperations?:ManualCloseOperation[]}}

export const closeSlotKey=(row:Pick<AccountPosition,'symbol'|'side'|'marginMode'|'positionId'|'positionOpenedAt'>)=>
  JSON.stringify([row.symbol,row.side,row.marginMode??null,row.positionId??null,row.positionOpenedAt??null]);
const legKey=(exchange:ExchangeId,row:Pick<AccountPosition,'symbol'|'side'>)=>`${exchange}:${row.symbol}:${row.side}`;
const tolerance=(q:number)=>Math.abs(q)*Number.EPSILON*8;

/** Verify the raw native slots behind one explicitly selected aggregate row. */
export function verifyCloseSlots(selected:AccountPosition,raw:AccountPosition[]):AccountPosition[]{
  if(!Array.isArray(raw)||raw.some(row=>row.symbol===selected.symbol&&row.side===selected.side&&(!Number.isFinite(row.quantity)||row.quantity<0)))throw new Error('原生分仓数量无效，尚未提交平仓');
  const slots=raw.filter(row=>row.symbol===selected.symbol&&row.side===selected.side&&row.quantity>0);
  if(!slots.length||slots.some(row=>row.base!==selected.base||!Number.isFinite(row.quantity)||row.quantity<=0||
    !['crossed','isolated'].includes(row.marginMode??'')||(row.splitPositionCount??1)>1))throw new Error('原生分仓读取不完整，尚未提交平仓');
  const keys=new Set(slots.map(closeSlotKey));
  if(keys.size!==slots.length||Math.abs(slots.reduce((sum,row)=>quantityAdd(sum,row.quantity),0)-selected.quantity)>tolerance(selected.quantity))
    throw new Error('原生分仓数量与所选合计不一致，请刷新实际持仓');
  // Without pid the margin slot must itself be unique; a timestamp is not a routing key.
  if(slots.some(row=>!row.positionId&&slots.filter(other=>other.marginMode===row.marginMode).length>1))
    throw new Error('同保证金模式分仓缺少唯一编号，不能确定减仓对象');
  if((selected.splitPositionCount??1)<=1&&(slots.length!==1||['positionId','marginMode','positionOpenedAt'].some(field=>{
    const key=field as 'positionId'|'marginMode'|'positionOpenedAt';return selected[key]!==undefined&&selected[key]!==slots[0][key];
  })))throw new Error('所选分仓身份或持仓周期已变化，请刷新后重新确认');
  return slots.map(row=>({...row}));
}

interface Options {
  store:Store;config:AppConfig;position:Position;selected:SelectedManualCloseLeg[];
  nativeSlots:ReadonlyMap<string,AccountPosition[]>;
  adapter:(exchange:ExchangeId)=>ExchangeAdapter;
  read:<T>(adapter:ExchangeAdapter,key:string,call:()=>Promise<T>)=>Promise<T>;
  ensure:()=>void;message:(error:unknown)=>string;
}

/** An ephemeral, reduce-only execution authority for a single explicit click.
 * It neither changes the engine's session permission nor resumes any holding.
 * Frozen native slot budgets are persisted on each child order's selector. */
export async function executeScopedManualClose(options:Options):Promise<void>{
  const {store,position:p,selected,adapter,read,ensure:ensureClick,config}=options;
  const startedAt=Date.now();
  // This is the real scoped execution window. Request acceptance and queueing may have happened earlier.
  const operationId=(()=>{try{const current=store.operations.current(p.id);return current?.kind!=='entry'?current?.id:undefined;}catch{return undefined;}})();
  const diagnostic=(action:(id:string)=>void)=>{if(operationId)try{action(operationId);}catch{/* Diagnostics cannot alter this click's execution authority. */}};
  diagnostic(id=>{store.operations.window(id,startedAt+MAX_BEST_PRICE_CLOSE_MS);
    store.operations.stage(id,'preparationStartedAt',startedAt,{code:'manual-preparation',text:'正在准备所选仓位的盘口与账户检查'});});
  const ensure=()=>{
    ensureClick();
    if(Date.now()-startedAt>=MAX_BEST_PRICE_CLOSE_MS)throw new Error('本次手动平仓处理窗口已结束，请刷新账户后重新确认剩余数量');
  };
  const books=new Map<ExchangeId,MarketSnapshot>(),initialOrderCount=store.data.orders.length;
  const frozen=new Map<string,AccountPosition[]>(),current=new Map<string,AccountPosition[]>();
  for(const leg of selected){
    const key=legKey(leg.exchange,leg.position),slots=options.nativeSlots.get(key)??[leg.position];
    frozen.set(key,slots.map(row=>({...row})));current.set(key,slots.map(row=>({...row})));
  }
  const chosen=(leg:PositionLeg)=>current.get(legKey(leg.exchange,leg))?.find(row=>row.quantity>0);
  const priorFilled=(exchange:ExchangeId,slot:AccountPosition)=>store.data.orders.slice(initialOrderCount)
    .filter(order=>order.positionId===p.id&&order.exchange===exchange&&order.request.reduceOnly&&order.request.symbol===slot.symbol&&
      (exchange!=='gate'||order.request.closePosition&&closeSlotKey({symbol:order.request.symbol,...order.request.closePosition})===closeSlotKey(slot)))
    .reduce((sum,order)=>quantityAdd(sum,order.result?.filledQuantity??0),0);
  let lastError:string|undefined;
  let lastBookError:string|undefined;
  const matchesBook=(quote:MarketSnapshot|undefined,exchange:ExchangeId)=>!!quote&&quote.exchange===exchange&&quote.base===p.base&&
    quote.symbol===selected.find(leg=>leg.exchange===exchange)?.position.symbol;
  const latestNativeBook=(exchange:ExchangeId)=>{
    const quote=adapter(exchange).getExecutionSnapshot?.(p.base);
    return quote?.bookTransport==='websocket'&&matchesBook(quote,exchange)&&quoteIsFresh(quote,config)?quote:undefined;
  };
  const scopedBook=(exchange:ExchangeId)=>{
    ensure();
    // A book can advance while a native validation waits. Never freeze the earlier WS object,
    // and never use another contract's stream to satisfy this click's exact selector.
    if(!books.has(exchange))return;
    const quote=latestNativeBook(exchange)??books.get(exchange);
    if(!matchesBook(quote,exchange)||!quoteIsFresh(quote,config)){
      lastBookError=`${exchange} 平仓盘口已过期或缺失，未使用旧盘口继续提交`;return;
    }
    books.set(exchange,quote);return quote;
  };
  const wrappers=new Map<ExchangeId,ExchangeAdapter>();
  const scopedAdapter=(exchange:ExchangeId):ExchangeAdapter=>{
    ensure();const existing=wrappers.get(exchange);if(existing)return existing;
    const native=adapter(exchange),targets=selected.filter(leg=>leg.exchange===exchange);
    if(!targets.length)throw new Error('平仓请求超出所选交易所');
    const check=(request:OrderRequest)=>{
      ensure();const target=targets.find(leg=>leg.position.symbol===request.symbol&&
        (leg.position.side==='long'?'sell':'buy')===request.side);
      if(!request.reduceOnly||!target||request.base!==p.base||!Number.isFinite(request.quantity)||request.quantity<=0)
        throw new Error('本次授权仅允许所选仓位减仓');
      const slot=exchange==='gate'?frozen.get(legKey(exchange,target.position))?.find(row=>request.closePosition&&
        closeSlotKey({symbol:request.symbol,...request.closePosition})===closeSlotKey(row)):target.position;
      if(!slot||request.quantity>quantitySubtract(slot.quantity,priorFilled(exchange,slot))+tolerance(slot.quantity))throw new Error('减仓数量超过本次确认范围');
    };
    const wrapper={id:exchange,
      getExecutionSnapshot:(base:string)=>base===p.base?scopedBook(exchange):undefined,
      validateOrder:async(request:OrderRequest)=>{try{diagnostic(id=>store.operations.wait(id,'manual-native-check','正在核对所选仓位的原生减仓条件'));
        check(request);await native.validateOrder?.(request);ensure();}catch(error){lastError=options.message(error);throw error;}},
      placeOrder:async(request:OrderRequest)=>{check(request);return native.placeOrder(request);},
      reconcileOrder:async(request:OrderRequest,id?:string)=>{
        // Reconciliation may cancel this exact newly created IOC, never unrelated user orders.
        if(!request.reduceOnly||!store.data.orders.slice(initialOrderCount).some(order=>order.positionId===p.id&&order.exchange===exchange&&order.request.clientOrderId===request.clientOrderId))
          throw new Error('订单不属于本次手动减仓');
        return native.reconcileOrder(request,id);
      },
    } as ExchangeAdapter;
    wrappers.set(exchange,wrapper);return wrapper;
  };
  const refreshBooks=async(base:string,exchanges:string[]):Promise<void>=>{
    try{
      ensure();const venues=[...new Set(exchanges)] as ExchangeId[];
      diagnostic(id=>store.operations.wait(id,'manual-book-check','正在读取所选合约的最新盘口'));
      // Retry only public books, inside this click's unchanged execution window. The engine's
      // read helper retains unresolved raw requests, so a timeout cannot spawn overlapping GETs.
      for(let attempt=0;attempt<3;attempt++){
        ensure();
        const results=await Promise.allSettled(venues.map(async exchange=>{
          const native=adapter(exchange),quotes=await read(native,`manual-close-book:${base}`,
            ()=>native.fetchExecutionSnapshots?native.fetchExecutionSnapshots([base]):native.fetchSnapshots([base]));
          return {exchange,quotes};
        }));ensure();
        const next=new Map<ExchangeId,MarketSnapshot>();let reason:string|undefined;
        for(let index=0;index<results.length;index++){
          const result=results[index],exchange=venues[index];
          if(result.status==='rejected'){reason??=options.message(result.reason);continue;}
          const exact=Array.isArray(result.value.quotes)?result.value.quotes.find(quote=>matchesBook(quote,exchange)):undefined;
          const quote=latestNativeBook(exchange)??exact;
          if(!quote){reason??=`${exchange} 待平仓合约缺少本轮完整盘口`;continue;}
          if(!quoteIsFresh(quote,config)){reason??=`${exchange} 平仓盘口已过期，等待最新盘口后重新确认`;continue;}
          next.set(exchange,quote);
        }
        if(!reason&&next.size===venues.length){
          const pair=[...next.values()];
          if(pair.length>1&&quoteSkewMs(pair[0],pair[1])>config.maxQuoteSkewMs)
            reason=`双腿平仓盘口采样不同步（相差 ${quoteSkewMs(pair[0],pair[1])} ms），未提交本批订单`;
        }
        if(!reason&&next.size===venues.length){
          for(const [exchange,quote] of next)books.set(exchange,quote);
          lastBookError=undefined;return;
        }
        lastBookError=reason??'待平仓合约缺少本轮完整盘口';
      }
      throw new Error(lastBookError);
    }catch(error){lastError=options.message(error);throw error;}
  };
  const maxSlots=Math.max(1,...[...frozen.values()].map(slots=>slots.length));
  const execution=new Execution(store,{
    closeOrderStartIndex:initialOrderCount,
    scopedFullClose:true,
    config:()=>({...config,maxOrderRetries:Math.min(8,Math.max(config.maxOrderRetries,maxSlots+1))}),
    snapshot:exchange=>books.get(exchange as ExchangeId),adapter:exchange=>scopedAdapter(exchange as ExchangeId),
    liveUnlocked:()=>{ensure();return true;},allowEntry:()=>false,
    prepareReduction:(leg,quantity)=>{
      ensure();const slot=chosen(leg);if(!slot)throw new Error(`${leg.exchange} 所选分仓已无可减数量，请核对账户`);
      const bounded=Math.min(quantity,slot.quantity);
      return {quantity:bounded,...(leg.exchange==='gate'?{closePosition:{side:slot.side,marginMode:slot.marginMode,
        ...(slot.positionId?{positionId:slot.positionId}:{}),...(slot.positionOpenedAt?{positionOpenedAt:slot.positionOpenedAt}:{})}}:{})};
    },
    refreshSnapshots:async(base,exchanges)=>{
      try{
        ensure();const venues=[...new Set(exchanges)] as ExchangeId[];
        diagnostic(id=>store.operations.wait(id,'manual-account-check','正在核对本次所选仓位的实际账户数量'));
        // Finish the frozen account/slot checks before taking short-lived execution books.
        // A slow account read must not consume the peer's two-second WS book lifetime.
        await Promise.all(venues.map(async exchange=>{
          const native=adapter(exchange),target=selected.find(leg=>leg.exchange===exchange)!;
          if(native.fetchTradingFee){
            diagnostic(id=>store.operations.wait(id,'manual-fee-check','正在核对所选合约手续费'));
            try{await read(native,`manual-close-fee:${target.position.symbol}`,()=>native.fetchTradingFee!(target.position.symbol));}
            catch{/* An explicit reduction still reconciles its actual paid fees from the fill receipt. */}
            ensure();
          }
          const rows=await (exchange==='gate'&&native.fetchClosePositions?
            read(native,`manual-close-slots:${target.position.symbol}`,()=>native.fetchClosePositions!(target.position.symbol)):
            read<AccountState>(native,'manual-close-account',()=>native.fetchAccount()).then(account=>account.positions));ensure();
          if(!Array.isArray(rows)||rows.some(row=>row.symbol===target.position.symbol&&row.side===target.position.side&&(!Number.isFinite(row.quantity)||row.quantity<0)))throw new Error(`${exchange} 账户数量无效，不能将未知数量视为空仓`);
          const key=legKey(exchange,target.position),initial=frozen.get(key)!,active=rows.filter(row=>row.symbol===target.position.symbol&&row.side===target.position.side&&row.quantity>0);
          if(active.some(row=>!initial.some(slot=>closeSlotKey(slot)===closeSlotKey(row))))throw new Error(`${exchange} 出现新的分仓或持仓周期，本次剩余平仓已停止`);
          const retained=initial.map(slot=>{
            const matches=active.filter(row=>closeSlotKey(row)===closeSlotKey(slot));
            if(matches.length>1)throw new Error(`${exchange} 分仓身份不唯一`);
            const row=matches[0],budget=quantitySubtract(slot.quantity,priorFilled(exchange,slot));
            if(row&&(!Number.isFinite(row.quantity)||row.quantity>budget+tolerance(slot.quantity)))throw new Error(`${exchange} 仓位数量增加，请重新确认平仓范围`);
            return {...slot,quantity:Math.min(row?.quantity??0,Math.max(0,budget))};
          });current.set(key,retained);
        }));ensure();
        await refreshBooks(base,venues);
      }catch(error){lastError=options.message(error);throw error;}
    },
    refreshReductionSnapshots:refreshBooks,
    halt:reason=>{lastError??=reason;},
  });
  try{
    await execution.close(p,'用户确认所选账户仓位手动平仓',undefined,{pricing:'best-opposite',requireProfit:false});
  }catch(error){
    diagnostic(id=>{
      const current=store.operations.current(p.id);
      const unknown=store.data.orders.some(order=>order.positionId===p.id&&isCurrentUnconfirmedOrder(order,store.data.positions))||
        current?.state==='unknown'||(current?.attempts.unknown??0)>0;
      if(!unknown&&current?.attempts.submitted===0&&current.attempts.preflightNotSent===0)
        store.operations.attemptNotSent(id,'manual-preparation-failed','本次准备未通过，未调用新的减仓下单适配器');
      const hasFill=(current?.confirmed.long??0)>0||(current?.confirmed.short??0)>0;
      store.operations.end(id,unknown?'unknown':hasFill?'partial':'failed',
        {code:unknown?'manual-original-unknown':'manual-close-failed',text:unknown?'本次原订单结果待核对，禁止重复减仓':'本次手动平仓未完成，请核对剩余数量后重新确认'});
    });
    throw error;
  }
  if(p.status!=='closed'){
    const unconfirmed=store.data.orders.some(order=>order.positionId===p.id&&isCurrentUnconfirmedOrder(order,store.data.positions));
    if(!unconfirmed){
      let reason=lastError??p.riskReasons[0];
      if(reason?.startsWith('首档暂不足合法')){
        const remaining=[p.long,p.short].filter(leg=>leg.quantity>0),pair=remaining.map(leg=>books.get(leg.exchange));
        reason=lastBookError??(pair.some(quote=>!quoteIsFresh(quote,config))?'平仓盘口已过期或缺失，未使用旧盘口继续提交':
          pair.length>1&&pair[0]&&pair[1]&&quoteSkewMs(pair[0],pair[1])>config.maxQuoteSkewMs?'双腿平仓盘口采样不同步，未提交本批订单':
          '当前对手价1可成交数量不足合法减仓批量，未扩大价格或数量范围');
      }
      p.riskReasons=[...(reason?[reason]:[]),'本次手动平仓已结束；请刷新实际账户数量后重新确认剩余仓位'];
    }
    // This authority ends with the click. An equal residual is not a running automatic close.
    p.status='attention';store.save();
  }
  diagnostic(id=>{
    // Execution owns exact order bindings and fill observations. A closed ledger is not a new account proof.
    store.operations.observe(p,store.data.orders);
    const current=store.operations.current(p.id);if(!current||current.id!==id)return;
    const unknown=store.data.orders.some(order=>order.positionId===p.id&&isCurrentUnconfirmedOrder(order,store.data.positions))||
      current.state==='unknown'||current.attempts.unknown>0;
    if(unknown)store.operations.end(id,'unknown',{code:'manual-original-unknown',text:'本次原订单结果待核对，禁止重复减仓'});
    else if(p.status==='closed')store.operations.wait(id,'manual-account-confirmation','成交已确认，等待账户数量核对');
    else{
      if(current.attempts.submitted===0&&current.attempts.preflightNotSent===0)
        store.operations.attemptNotSent(id,'manual-preparation-failed','本次准备未通过，未调用新的减仓下单适配器');
      const windowEnded=Date.now()-startedAt>=MAX_BEST_PRICE_CLOSE_MS;
      const hasFill=(current.confirmed.long??0)>0||(current.confirmed.short??0)>0;
      store.operations.end(id,hasFill?'partial':'failed',
        {code:windowEnded?'manual-window-ended':'manual-processing-ended',text:windowEnded?
          '本次手动平仓处理窗口已结束，剩余数量需要重新确认':'本次手动处理已结束，仍有剩余数量需要重新确认'});
    }
  });
}

export const manualCloseLegKey=legKey;
