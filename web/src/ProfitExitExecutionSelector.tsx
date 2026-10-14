import type {AppConfig} from '../../src/shared/types';

export default function ProfitExitExecutionSelector({config,onChange}:{
  config:AppConfig;onChange:(value:NonNullable<AppConfig['profitExitExecutionMode']>)=>void;
}){
  return <label className="config-field"><span>盈利平仓执行方式</span>
    <select aria-label="盈利平仓执行方式" value={config.profitExitExecutionMode??'maker'}
      onChange={event=>onChange(event.target.value as NonNullable<AppConfig['profitExitExecutionMode']>)}>
      <option value="ioc">双腿对手价1限价 IOC · 只减仓</option>
      <option value="maker">宽盘口腿 Maker · 成交后对侧 IOC</option>
    </select>
    <small>两种方式都按双腿对手价1、返佣后原本金盈利门槛触发。IOC 尝试立即成交，未成交余量取消；每批按真实成交处理差量。保存执行方式变更后暂停新开仓，原订单须先完成核对。</small>
  </label>;
}
