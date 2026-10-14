import type {AppConfig} from '../../src/shared/types';
import {feeRebatePct} from '../../src/shared/fee-rebates';

/** User-declared automatic rebates, used only in estimates; saving never fetches or books a rebate. */
export default function FeeRebateControls({config,onChange}:{config:AppConfig;
  onChange:<K extends keyof AppConfig>(key:K,value:AppConfig[K])=>void}){
  return <section className="panel config-section"><h3>官方自动手续费返佣</h3>
    <p>按填写比例参与收益和费用估算，不读取返佣接口。交易所实际收取的手续费与已到账资金费单独保留；预计返佣不会写成实账收入。</p>
    <div className="config-grid">{(['gate','bitget'] as const).map(exchange=><label className="config-field" key={exchange}>
      <span>{exchange==='gate'?'Gate':'Bitget'} 手续费返佣</span><div className="input-unit">
        <input aria-label={`${exchange==='gate'?'Gate':'Bitget'} 手续费返佣`} name={`feeRebatePct.${exchange}`}
          type="number" required min={0} max={100} step={1} value={feeRebatePct(exchange,config)}
          onChange={event=>onChange('feeRebatePct',{...config.feeRebatePct,[exchange]:Number(event.target.value)})}/><span>%</span>
      </div><small>仅对正手续费估算返佣；原生负手续费不重复返佣。</small>
    </label>)}</div>
  </section>;
}
