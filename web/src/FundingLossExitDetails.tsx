import type {FundingLossExit} from '../../src/shared/types';
import {positionNumber as number} from './position-formatters';

const cash=(value:number)=>Number.isFinite(value)?`${value<0?'−':''}$${Math.abs(value).toFixed(4)}`:'待核验';

export default function FundingLossExitDetails({estimate}:{estimate:FundingLossExit}){
  return <div className="ledger-note ledger-funding-loss-exit" aria-label="付款前退出成本比较">
    <p><b>付款前退出成本比较 · 本批估算</b></p>
    <dl>
      <div><dt>本批双腿共同可平数量</dt><dd>{Number.isFinite(estimate.quantity)&&estimate.quantity>0?number(estimate.quantity):'待核验'}</dd></div>
      <div><dt>本批预计净资金费支出</dt><dd>{cash(estimate.expectedFundingLossUsd)}</dd></div>
      <div><dt>本批平仓手续费</dt><dd>{cash(estimate.closingFeesUsd)}</dd></div>
      <div><dt>本批盘口损耗</dt><dd>{cash(estimate.spreadCostUsd)}</dd></div>
      <div><dt>本批退出成本合计</dt><dd>{cash(estimate.exitCostAllowanceUsd)}</dd></div>
      <div><dt>本批最低余量</dt><dd>{cash(estimate.minimumSavingsUsd)}</dd></div>
      <div><dt>预计支出扣退出成本后余量</dt><dd>{cash(estimate.expectedSavingsUsd)}</dd></div>
      <div><dt>付款前窗口</dt><dd>{estimate.paymentWindowOpen?'已进入结算前 5 分钟':'等待下一次实际付款前 5 分钟'}</dd></div>
    </dl>
    <p>这里只比较本批剩余持仓的预计支出和当前退出成本，既有盈亏仍在平仓净损益中如实展示。平仓手续费也可能在以后退出时发生，这里将其作为保守成本门槛。最低余量按本批数量分摊整仓 $0.10；未公布的未来费率按当前值推算，可能变化，表中余量不保证实际节省或盈利。每批提交前按最新盘口和实际限价重新核验，条件不足时保留等量余仓。</p>
  </div>;
}
