import type {AppState} from './types.js';

/** Read-only browser projection. Public opportunities get their complete entry
 * evidence from /api/funding-opportunities; state supplies the navigation count.
 * Keep all financial fields and full-depth snapshots used by holding estimates.
 * This view is never used by the execution engine or its eligibility checks. */
export function dashboardState(state:AppState):AppState {
  if(state.config.dataSource!=='public')return state;
  return {...state,opportunities:state.opportunities.map(opportunity=>{
    const {checks,spreadAdvantage,historicalSpreadAdvantage,...summary}=opportunity;
    return summary;
  })};
}
