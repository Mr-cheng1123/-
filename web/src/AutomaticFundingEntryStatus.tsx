import type {Opportunity} from '../../src/shared/types';
import {automaticFundingStabilityPresentation} from './automatic-entry-presentation';

/** Separate from the manual entry checklist so pending automatic evidence cannot disable a manual action. */
export default function AutomaticFundingEntryStatus({opportunity,details=false,fresh=true}:{opportunity?:Opportunity;details?:boolean;fresh?:boolean}) {
  const presentation=fresh?automaticFundingStabilityPresentation(opportunity):
    {label:'自动资金费等待新行情',kind:'orange',reason:'当前机会核验证据已过期，等待新鲜双腿数据后重新核验资金费收益。',progress:'等待新鲜双腿数据'};
  return <div className="automatic-funding-entry-status" data-testid="automatic-funding-entry-status" title={presentation.reason}>
    <span className={`badge ${presentation.kind}`}>{presentation.label}</span>
    {details&&<><span className="cell-caption">{presentation.progress}</span><span className="cell-caption">{presentation.reason} 资金费收益达标后，仍需价格、手续费、数量与账户条件通过。</span></>}
  </div>;
}
