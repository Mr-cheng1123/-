import type { AppConfig, AccountState, ExchangeAdapter, ExchangeId, LiveCoinExclusion } from '../shared/types.js';
import {accountCoins} from './coin-exclusions.js';
import type { LiveEnvironment } from './live-readiness.js';
import {bitgetAccountReadError} from '../adapters/bitget-account.js';
import {gateReadError} from '../adapters/gate-private.js';
import {bybitReadError} from '../adapters/bybit-private.js';
import {exchangeApiCode,ExchangeNetworkError} from '../adapters/network.js';
import {tradingError} from './trading-errors.js';

export interface LiveStartAccount {
  exchange:ExchangeId;
  credentialsConfigured:boolean;
  status:'ready'|'not_configured'|'insufficient'|'error';
  freeUsd?:number;
  requiredUsd:number;
  message:string;
  excludedCoins?:string[];
}

export interface LiveStartReadiness {
  canStart:boolean;
  executionUnlocked:boolean;
  orderNotionalUsd:number;
  bitgetNewSymbolMarginMode?:'crossed'|'isolated';
  accounts:LiveStartAccount[];
  blockers:string[];
  excludedCoins?:LiveCoinExclusion[];
  canRecover?:boolean;
  recoveryBlockers?:string[];
  managementExchanges?:ExchangeId[];
}

export interface LiveStartContext {
  executionUnlocked:boolean;
  blockedReasons:string[];
  excludedCoins?:LiveCoinExclusion[];
  adapter:(exchange:ExchangeId)=>Pick<ExchangeAdapter,'fetchAccount'>;
  timeoutMs?:number;
  recoveryExchanges?:ExchangeId[];
  recoveryBlockedReasons?:string[];
}

type AccountRead={kind:'account';account:AccountState}|{kind:'error';message?:string}|{kind:'timeout'};

/** A bounded read only: late completion is observed but cannot change the returned report. */
async function readAccount(exchange:ExchangeId,context:LiveStartContext,timeoutMs:number):Promise<AccountRead>{
  let timer:ReturnType<typeof setTimeout>|undefined;
  const request:Promise<AccountRead>=Promise.resolve().then(()=>context.adapter(exchange).fetchAccount()).then(
    account=>({kind:'account',account}),error=>({kind:'error',message:
      (exchange==='bitget'?bitgetAccountReadError(error):exchange==='gate'?gateReadError(error):exchange==='bybit'?bybitReadError(error):undefined)??
      (error instanceof ExchangeNetworkError||exchangeApiCode(exchange,error)?tradingError(exchange,'账户检查',error).message:undefined)}),
  );
  try{
    return await Promise.race([request,new Promise<AccountRead>(resolve=>{
      timer=setTimeout(()=>resolve({kind:'timeout'}),timeoutMs);
    })]);
  }finally{if(timer)clearTimeout(timer);}
}

/** Checks strict futures principal only: no exact symbol exists here, so native fees are verified on the concrete entry.
 * This function never unlocks, starts, or prepares trading. */
export async function inspectLiveStart(config:AppConfig,environment:LiveEnvironment,context:LiveStartContext):Promise<LiveStartReadiness>{
  const blockers=[...context.blockedReasons];
  const validMode=config.mode==='live'&&config.dataSource==='public';
  if(!validMode)blockers.push('启动检查仅适用于实盘公开行情模式');
  const validSize=Number.isFinite(config.orderNotionalUsd)&&config.orderNotionalUsd>0&&Number.isFinite(config.leverage)&&config.leverage>0;
  const required=new Map<ExchangeId,number>();
  for(const exchange of config.exchanges){
    const value=validSize?config.orderNotionalUsd/config.leverage:NaN;
    required.set(exchange,value);
  }
  const validAmounts=validSize&&[...required.values()].every(value=>Number.isFinite(value)&&value>0);
  if(!validAmounts)blockers.push('每腿金额或杠杆配置无效，无法计算所需保证金本金');
  const timeoutMs=Number.isFinite(context.timeoutMs)&&context.timeoutMs!>0?Math.min(context.timeoutMs!,8000):8000;
  const validAccounts=new Set<ExchangeId>();
  const accounts=await Promise.all(config.exchanges.map(async(exchange):Promise<LiveStartAccount>=>{
    const venue=environment.exchanges.find(item=>item.exchange===exchange);
    const credentialsConfigured=venue?.credentialsConfigured===true;
    const amount=required.get(exchange)!;
    const base={exchange,credentialsConfigured,requiredUsd:Number.isFinite(amount)&&amount>0?amount:0};
    if(!credentialsConfigured)return {...base,status:'not_configured',message:'凭据尚未完整配置；可使用其他已就绪交易所'};
    if(venue?.supported!==true)return {...base,status:'error',message:'此交易所暂不支持实盘执行检查'};
    if(!validMode||!validAmounts)return {...base,status:'error',message:'启动配置无效，未读取私有账户'};
    const result=await readAccount(exchange,context,timeoutMs);
    if(result.kind==='timeout')return {...base,status:'error',message:'账户只读检查超时，请重新检查'};
    if(result.kind==='error')return {...base,status:'error',message:result.message??'账户只读检查失败，请核对凭据、权限及账户设置'};
    const account=result.account;
    const excludedCoins=accountCoins(account);
    if(!excludedCoins)
      return {...base,status:'error',message:'账户余额或持仓数据不完整，无法确认启动条件'};
    validAccounts.add(exchange);
    const freeUsd=account.freeUsd;
    if(freeUsd<amount)return {...base,freeUsd,excludedCoins,status:'insufficient',message:'合约可用保证金不足以覆盖本腿本金；具体合约官方手续费在下单前核验'};
    const gateMode=exchange==='gate'?({single:'单向',dual:'双向',dual_plus:'双向分仓'} as Record<string,string>)[account.positionMode??'']:undefined;
    return {...base,freeUsd,excludedCoins,status:'ready',message:`${gateMode?`Gate ${gateMode}模式已核验；`:''}合约可用余额满足本腿本金；具体合约官方手续费在下单前核验${excludedCoins.length?`；已有 ${excludedCoins.join('、')} 持仓，仅跳过这些币种，其他币种可交易`:'；未发现已有非零仓位'}`};
  }));
  if(new Set(accounts.filter(account=>account.status==='ready').map(account=>account.exchange)).size<2)
    blockers.push('至少需要两家已配置且合约可用余额充足的交易所');
  const uniqueBlockers=[...new Set(blockers)];
  const excluded=new Map<string,LiveCoinExclusion>();
  for(const item of context.excludedCoins??[])excluded.set(item.base,{base:item.base,exchanges:[...item.exchanges],reasons:[...item.reasons]});
  for(const account of accounts)for(const base of account.excludedCoins??[]){
    const item=excluded.get(base)??{base,exchanges:[],reasons:[]};
    item.exchanges=[...new Set([...item.exchanges,account.exchange])];
    item.reasons=[...new Set([...item.reasons,'交易所已有该币种持仓'])];excluded.set(base,item);
  }
  let recovery:Pick<LiveStartReadiness,'canRecover'|'recoveryBlockers'|'managementExchanges'>={};
  if(context.recoveryExchanges?.length){
    const recoveryBlockers=[...(context.recoveryBlockedReasons??[])];
    if(!validMode)recoveryBlockers.push('恢复管理仅适用于实盘公开行情模式');
    if(!validAmounts)recoveryBlockers.push('当前配置无效，无法完成恢复管理账户检查');
    if(validAccounts.size<1)recoveryBlockers.push('恢复管理至少需要一家已完成有效账户读取的交易所');
    for(const exchange of new Set(context.recoveryExchanges))if(!validAccounts.has(exchange))
      recoveryBlockers.push(`需恢复管理的交易所 ${exchange} 未完成有效账户读取`);
    recovery={canRecover:recoveryBlockers.length===0,recoveryBlockers:[...new Set(recoveryBlockers)],
      managementExchanges:[...new Set(config.exchanges)].filter(exchange=>validAccounts.has(exchange))};
  }
  return {canStart:uniqueBlockers.length===0,executionUnlocked:context.executionUnlocked,
    bitgetNewSymbolMarginMode:config.bitgetNewSymbolMarginMode??'isolated',
    orderNotionalUsd:Number.isFinite(config.orderNotionalUsd)&&config.orderNotionalUsd>0?config.orderNotionalUsd:0,
    accounts,blockers:uniqueBlockers,excludedCoins:[...excluded.values()].sort((a,b)=>a.base.localeCompare(b.base)),...recovery};
}
