import { Check, CircleDashed, X } from 'lucide-react';
import type { EntryCheck, Opportunity } from '../../src/shared/types';
import './entry-checklist.css';
import AutomaticFundingEntryStatus from './AutomaticFundingEntryStatus';

const groups: Record<EntryCheck['group'], string> = { funding: '收益', spread: '价差', timing: '结算数据', market: '成交条件', account: '账户', execution: '执行状态' };
const order: EntryCheck['group'][] = ['funding', 'spread', 'timing', 'market', 'account', 'execution'];

/** Everything that can stop an entry, failing items first. Built from the same checks the server used to decide. */
export function EntryChecklist({ opportunity, candidateReasons = [], verified, synchronizing = false, note }: { opportunity?: Opportunity; candidateReasons?: string[]; verified: boolean; synchronizing?: boolean; note?: string }) {
  const checks = opportunity?.checks ?? [];
  const known = new Set(checks.map(check => check.reason));
  // Limits added outside the strategy calculation (account balance, open positions, cooldown, connection ...).
  // A detailed verification replaces the coarser funding-statistics estimate.
  // Showing old candidate blockers next to a successful verification is misleading.
  const other = [...new Set(opportunity?.reasons ?? candidateReasons.filter(reason => !reason.includes('待核验')))].filter(reason => !known.has(reason));
  const failing = checks.filter(check => check.pass === false);
  // Accounts are read again immediately before submitting. A deferred account
  // read is not missing market data and must agree with an eligible opportunity.
  const beforeSubmit = checks.filter(check => check.pass === null && check.group === 'account');
  const waiting = checks.filter(check => check.pass === null && check.group !== 'account');
  const passed = checks.filter(check => check.pass === true);
  const blocked = failing.length + other.length;

  if (!opportunity) return <section className="entry-check pending">
    <header><CircleDashed size={18}/><div><b>{note ? '后台等待重试盘口' : '后台自动核验盘口'}</b><p>{note ?? '后台分批读取公共盘口，取得数据后自动列出每项条件，无需逐行点击；下方按钮可手动重试。核验只读取行情，不会下单。'}</p></div></header>
    <AutomaticFundingEntryStatus details/>
    {other.length > 0 && <ul className="entry-check-list">{other.map((reason, index) => <li key={index} className="fail"><X size={13}/><span><b>{reason}</b></span></li>)}</ul>}
  </section>;

  const ready = !synchronizing && (opportunity.eligible || opportunity.entryReady === true) && verified && blocked === 0 && waiting.length === 0;
  const prepared = ready && !opportunity.eligible;
  const verdict = prepared ? '手动可开仓' : ready ? '收益与成交条件通过' : blocked > 0 ? `条件不满足 · ${blocked} 项` : synchronizing ? '正在同步最新授权与核验结果' : waiting.length > 0 ? '等待行情或价差样本' : '等待核验结果同步';
  return <section className={`entry-check ${ready ? 'ok' : blocked > 0 ? 'blocked' : 'pending'}`}>
    <header>{ready ? <Check size={18}/> : blocked > 0 ? <X size={18}/> : <CircleDashed size={18}/>}<div><b>{verdict}</b><p>{prepared ? '盘口、资金费和账户读取已就绪。点击实盘开仓后，提交前重新核验并授权所选两腿；自动策略保持当前状态。' : ready ? opportunity.entryPolicy==='aligned'?'资金费为正且 IOC 价格优势已达标；单轮净收益仅供参考，提交前重新读取盘口和账户。':opportunity.entryPolicy==='funding'||opportunity.spreadAdvantage?.estimateMethod==='current-book'?'资金费扣手续费与盘口开平损耗后收益达标；提交前重新读取盘口和账户。':'资金费、价差与合计收益已通过；提交前重新读取盘口和账户。' : blocked > 0 ? '以下为当前不能提交的具体原因，只影响这笔机会。' : '取得所需数据后自动重新判断。'}</p></div></header>
    <AutomaticFundingEntryStatus opportunity={opportunity} details/>
    {blocked > 0 && <ul className="entry-check-list">
      {order.flatMap(group => failing.filter(check => check.group === group)).map((check, index) => <li key={`f${index}`} className="fail"><X size={13}/><span>
        <b>{check.label}</b>
        {(check.actual !== undefined || check.required !== undefined) && <em>当前 <strong>{check.actual ?? '—'}</strong>{check.required !== undefined && <> · 需要 {check.required}</>}</em>}
        {check.actual === undefined && check.required === undefined && <em>{check.reason}</em>}
      </span><small>{groups[check.group]}</small></li>)}
      {other.map((reason, index) => <li key={`o${index}`} className="fail"><X size={13}/><span><b>{reason}</b></span><small>执行状态</small></li>)}
    </ul>}
    {synchronizing && <p className="entry-check-wait"><CircleDashed size={12}/>账户状态已更新，正在读取最新入场检查；同步期间不提交订单。</p>}
    {waiting.length > 0 && <p className="entry-check-wait"><CircleDashed size={12}/>等待数据，暂不判定：{waiting.map(check => check.label).join('、')}</p>}
    {beforeSubmit.length > 0 && <p className="entry-check-before-submit"><CircleDashed size={12}/>提交前确认：{beforeSubmit.map(check => check.label).join('、')}</p>}
    {passed.length > 0 && <details className="entry-check-passed"><summary>已通过 {passed.length} 项</summary>
      <ul className="entry-check-list">{order.flatMap(group => passed.filter(check => check.group === group)).map((check, index) => <li key={index} className="pass"><Check size={12}/><span><b>{check.label}</b>{check.actual !== undefined && <em>{check.actual}{check.required !== undefined && <> · 要求 {check.required}</>}</em>}</span><small>{groups[check.group]}</small></li>)}</ul>
    </details>}
  </section>;
}
