import type {AppConfig} from '../../src/shared/types';

/** Shared wording for aligned positions using adaptive holding. */
export const ALIGNED_ADAPTIVE_HOLDING_RULE='双腿按对手价1可平净收益严格超过原开仓单腿本金的配置门槛（默认 10 bps，100 U 对应 0.10 U）才开始分批获利退出；本金按两腿实际开仓名义额平均冻结，分批不降低基数。支持的实盘路径先挂宽盘口腿 Maker，确认部分成交后对侧按确认量 IOC；Maker 只用于执行省费，不提高报价提前触发。正资金费及劣势持续确认不阻挡获利退出；未达门槛时，本轮净资金费为正则续持。若下一次实际结算为付款，劣势持续确认且在结算前 5 分钟内，预计本轮净资金费支出严格超过平仓手续费、盘口损耗及固定 $0.10 余量，允许受控亏损退出。每批重新核验实际费用、现金与盘口；未来资金费不计入当前净收益，后续成交价格可能变化。';

export const FUNDING_LOSS_EXIT_EXPLANATION='受控亏损退出比较未来预计净资金费支出与当前平仓手续费、盘口损耗及 $0.10 余量；既有亏损不阻挡退出。须持续确认劣势、下一次实际结算为付款且在结算前 5 分钟内，每批按实际数量重新核验。$0.10 为整仓余量，分批按数量比例分摊；未来费率和后续成交价格可能变化。条件不足时保留等量余仓，等待重新核验。';

export function alignedAdaptiveHoldingRule(config:Pick<AppConfig,'profitExitExecutionMode'>):string {
  if(config.profitExitExecutionMode!=='ioc')return ALIGNED_ADAPTIVE_HOLDING_RULE;
  return ALIGNED_ADAPTIVE_HOLDING_RULE.replace(
    '支持的实盘路径先挂宽盘口腿 Maker，确认部分成交后对侧按确认量 IOC；Maker 只用于执行省费，不提高报价提前触发。',
    '两腿按对手价1限价 IOC 并行分批只减仓，未成交余量取消；真实成交差量优先补齐，未知原单先核对，不留排队挂单。');
}
