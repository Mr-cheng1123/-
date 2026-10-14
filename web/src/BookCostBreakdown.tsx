import type { Opportunity, RoundTripBookCost } from '../../src/shared/types';
import { bookCostMoney, bookCostScope, bookObservedAt, bookPrice, bookQuantity, isCurrentBookEstimate, opportunityBookLoss, usableBookCost } from './book-cost-presentation';

const venues = { binance: 'Binance', bybit: 'Bybit', okx: 'OKX', gate: 'Gate', bitget: 'Bitget' };
const signedMoney = (value: number | null | undefined) => typeof value === 'number' && Number.isFinite(value)
  ? `${value < 0 ? '−' : value > 0 ? '+' : ''}${bookCostMoney(Math.abs(value))}` : '待计算';

function CostEvidence({ cost, opportunity, firstBatch = false }: { cost: RoundTripBookCost; opportunity: Opportunity; firstBatch?: boolean }) {
  return <section className="book-cost-evidence" aria-label={firstBatch ? '当前首批盘口成本依据' : '完整目标盘口成本依据'}>
    <div className="book-cost-heading"><h4>{firstBatch ? '当前首批盘口开平损耗' : '完整目标盘口开平损耗'}</h4><strong>{bookCostMoney(cost.roundTripBookLossUsd)}</strong></div>
    <p className="book-cost-scope">两腿各 {bookQuantity(cost.quantity)} 币 · 费用另计</p>
    <dl className="book-cost-components">
      <div><dt>开仓损耗</dt><dd>{bookCostMoney(cost.openingCostUsd)}</dd></div>
      <div className="book-cost-part"><dt>买卖差 / 消耗深度</dt><dd>{bookCostMoney(cost.openingSpreadCostUsd)} / {bookCostMoney(cost.openingDepthImpactUsd)}</dd></div>
      <div><dt>平仓损耗（当前盘口估计）</dt><dd>{bookCostMoney(cost.closingCostUsd)}</dd></div>
      <div className="book-cost-part"><dt>买卖差 / 消耗深度</dt><dd>{bookCostMoney(cost.closingSpreadCostUsd)} / {bookCostMoney(cost.closingDepthImpactUsd)}</dd></div>
    </dl>
    <p className="book-cost-times">买卖差按各交易所盘口中间价计量，开仓与平仓分别计算；消耗深度另列。</p>
    <div className="book-cost-prices"><table><thead><tr><th>估算成交均价</th><th>开仓</th><th>平仓</th></tr></thead><tbody>
      <tr><th>多腿 · {venues[opportunity.longExchange]}</th><td>{bookPrice(cost.longOpenPrice)}<small>买入</small></td><td>{bookPrice(cost.longClosePrice)}<small>卖出</small></td></tr>
      <tr><th>空腿 · {venues[opportunity.shortExchange]}</th><td>{bookPrice(cost.shortOpenPrice)}<small>卖出</small></td><td>{bookPrice(cost.shortClosePrice)}<small>买入</small></td></tr>
    </tbody></table></div>
    <p className="book-cost-times">估算盘口采样：多腿 {bookObservedAt(cost.longObservedAt)}；空腿 {bookObservedAt(cost.shortObservedAt)}</p>
    {firstBatch && <dl className="book-cost-batch-accounting"><div><dt>本批预计资金费</dt><dd>{signedMoney(opportunity.entryBatch?.expectedFundingUsd)}</dd></div><div><dt>本批四笔手续费（独立估计）</dt><dd>{bookCostMoney(cost.feesUsd)}</dd></div><div><dt>本批单轮净收益（条件参考）</dt><dd>{signedMoney(opportunity.entryBatch?.expectedNetUsd)}</dd></div></dl>}
  </section>;
}

export default function BookCostBreakdown({ opportunity }: { opportunity?: Opportunity }) {
  if (!opportunity || !isCurrentBookEstimate(opportunity)) return null;
  const full = opportunity.spreadAdvantage?.status === 'warming' ? undefined : usableBookCost(opportunity.bookCost);
  const first = usableBookCost(opportunity.entryBatch?.bookCost);
  const batchQuantity = opportunity.entryBatch?.batchQuantity;
  const showFirst = typeof batchQuantity === 'number' && Number.isFinite(batchQuantity) && batchQuantity > 0 &&
    batchQuantity < (opportunity.bookCost?.quantity ?? opportunity.longQuantity) * (1 - 1e-9);
  const unavailableReason = opportunity.spreadAdvantage?.status === 'warming'
    ? opportunity.spreadAdvantage.reason ?? '完整开平仓盘口尚未齐备，成本等待新采样'
    : opportunity.bookCost ? '当前成本分项不完整，等待有效的新估算'
      : opportunityBookLoss(opportunity) !== null ? '当前回复只有损耗汇总，未提供分项与四边均价'
        : '完整开平仓盘口尚未齐备，成本等待新采样';
  return <div className="book-cost-breakdown">
    {full ? <CostEvidence cost={full} opportunity={opportunity}/> : <section className="book-cost-evidence" aria-label="完整目标盘口成本依据"><div className="book-cost-heading"><h4>完整目标盘口开平损耗</h4><strong>{bookCostMoney(opportunityBookLoss(opportunity))}</strong></div><p className="book-cost-scope">{bookCostScope(opportunity)} · 费用另计</p><p className="book-cost-times">{unavailableReason}；不使用页面后续盘口补算。</p></section>}
    {full && batchQuantity === full.quantity && <p className="book-cost-times">当前首批与完整目标数量相同，共用此份估算。</p>}
    {showFirst && (first ? <CostEvidence cost={first} opportunity={opportunity} firstBatch/> : <section className="book-cost-evidence" aria-label="当前首批盘口成本依据"><div className="book-cost-heading"><h4>当前首批盘口开平损耗</h4><strong>待计算</strong></div><p className="book-cost-scope">两腿各 {bookQuantity(batchQuantity)} 币 · 首批四边盘口或成本分项尚未齐备</p></section>)}
    <p className="book-cost-formula">盘口损耗＝数量 ×［多腿开仓买价－多腿平仓卖价＋空腿平仓买价－空腿开仓卖价］；不含手续费。未来平仓按当前盘口和基差不变估计，跨所开仓价差尚未兑现，基差变化会改变实际盈亏。</p>
    <p className="book-cost-times">若已配置手续费返佣，手续费项按返佣后的净成本估算；预计返佣不代表已核对到账收入。</p>
  </div>;
}
