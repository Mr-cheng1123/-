import type {AppConfig,Position} from './types.js';

type ExitStrategyConfig=Pick<AppConfig,'entryPolicy'|'holdMode'>;

/** Current ordinary-strategy exit rules never adopt an imported/manual reduction ledger. */
export function usesCurrentExitStrategy(position:Position,config:ExitStrategyConfig):boolean {
  return config.entryPolicy==='aligned'&&config.holdMode==='adaptive'&&
    !position.manualCloseOnly&&!position.manualCloseAccountRecord&&!position.accountClosure;
}

/** Economic view only. Execute with the original position and legs; historical entry rules and cash stay intact. */
export function currentExitStrategyPosition(position:Position,config:ExitStrategyConfig):Position {
  if(!usesCurrentExitStrategy(position,config)||position.entryPolicy==='aligned'&&position.holdMode==='adaptive')return position;
  return {...position,entryPolicy:'aligned',holdMode:'adaptive'};
}
