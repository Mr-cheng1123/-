import type { AppConfig } from '../../src/shared/types';
import { entryPolicy } from './entry-policy';

export default function EntryExecutionSelector({ config, onChange }: {
  config: AppConfig; onChange: (value: NonNullable<AppConfig['entryExecutionMode']>) => void;
}) {
  const makerSupported = entryPolicy(config) === 'aligned';
  return <label className="config-field"><span>新开仓执行方式</span>
    <select aria-label="新开仓执行方式" value={makerSupported ? config.entryExecutionMode ?? 'ioc' : 'ioc'}
      onChange={event => onChange(event.target.value as NonNullable<AppConfig['entryExecutionMode']>)}>
      <option value="ioc">对手价1 IOC 分批</option>
      <option value="maker-ioc" disabled={!makerSupported}>Maker 首腿 + 对手价1 IOC 对冲 · 试运行</option>
    </select>
    {!makerSupported ? <small>当前入场模式使用 IOC。Maker + IOC 仅支持“资金费与价格同向”；切换至其他入场模式会将待保存的执行方式调整为 IOC。</small> :
      <small>先按空腿卖1只挂单，观察到成交即撤掉未成交部分，确认后按真实成交数量补多腿。未成交不补另一腿，状态不明暂停该币种。须有官方 Maker 费率与新鲜双腿盘口；挂单省费不保证总收益更好，执行统计可比较。</small>}
  </label>;
}
