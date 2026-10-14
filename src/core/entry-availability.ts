import type {EntryCheck,Opportunity} from '../shared/types.js';

export interface EntryAvailability {
  stopped:boolean;
  authorized:boolean;
  accountsReady?:boolean|null;
  balances:Array<{exchange:string;availableUsd?:number;requiredUsd:number}>;
  coinReasons:string[];
  cooldownUntil:number;
  candidateCurrent:boolean;
  marketAvailable:boolean;
  contracts?:Array<{exchange:string;status:'ready'|'pending'|'failed';reason?:string}>;
}

/** Execution availability is local to this pair. These checks never stop another coin or venue.
 * The same result is rendered by the API and checked immediately before submitting orders. */
export function applyEntryAvailability(opportunity:Opportunity,availability:EntryAvailability,now=Date.now()):Opportunity {
  const checks=[...(opportunity.checks??[])],reasons=[...opportunity.reasons];
  const check=(group:EntryCheck['group'],label:string,pass:boolean|null,reason:string)=>{
    checks.push({group,label,pass,reason});if(pass===false)reasons.push(reason);
  };
  check('execution','新开仓未停止',!availability.stopped,'已手动紧急停止，新开仓暂停');
  check('account','两腿交易账户已授权',availability.authorized,'实盘执行锁定或该交易所账户未就绪');
  check('account','两腿账户读取就绪',availability.accountsReady===undefined?availability.authorized:availability.accountsReady,'两腿账户尚未取得新鲜、有效的只读余额');
  if(availability.contracts){
    const failed=availability.contracts.filter(contract=>contract.status==='failed');
    check('execution','两腿合约只读检查就绪',failed.length?false:availability.contracts.every(contract=>contract.status==='ready')?true:null,
      failed.map(contract=>contract.reason??`${contract.exchange} 合约只读检查未通过`).join('；')||'后台正在读取两腿具体合约参数，提交前还会重新核对');
  }
  const insufficient=availability.balances.filter(x=>x.availableUsd!==undefined&&(!Number.isFinite(x.availableUsd)||!Number.isFinite(x.requiredUsd)||x.availableUsd<x.requiredUsd));
  check('account','两腿保证金可用',insufficient.length?false:availability.balances.some(x=>x.availableUsd===undefined)?null:true,
    insufficient.map(x=>`${x.exchange} 合约可用余额不足`).join('；')||'下单前读取并确认两腿可用保证金');
  check('execution','该币种没有重复仓位或待核对订单',availability.coinReasons.length===0,availability.coinReasons.join('；'));
  check('execution','该币种可以重试',availability.cooldownUntil<=now,`上次开仓未能形成对冲，冷却中（约 ${Math.max(0,Math.ceil((availability.cooldownUntil-now)/1000))} 秒后可重试）`);
  check('market','资金费率候选仍有效',availability.candidateCurrent,'当前全市场费率候选未通过或已过期');
  check('market','该币种盘口读取成功',availability.marketAvailable,'该币种详细行情核验失败');
  const unique=[...new Set(reasons)];
  const entryReady=opportunity.eligible&&opportunity.reasons.length===0&&checks.every(item=>
    item.group==='account'&&item.label==='两腿交易账户已授权'||item.pass===true);
  return {...opportunity,entryReady,checks,reasons:unique,eligible:opportunity.eligible&&unique.length===0,risk:unique.length?'high':'low'};
}
