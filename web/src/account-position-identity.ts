import type {AccountPosition,ExchangeId,PositionLeg} from '../../src/shared/types';

/** Read-only account row identity. Margin mode separates venue rows when no native position ID is supplied. */
export function accountPositionKey(exchange:ExchangeId,row:Pick<AccountPosition,'symbol'|'side'|'marginMode'|'positionId'>):string {
  return JSON.stringify([exchange,row.symbol,row.side,row.marginMode??null,row.positionId??null]);
}

/** Saved execution legs without a row key still observe the whole exact contract and side. */
export function accountPositionMatchesLeg(exchange:ExchangeId,row:AccountPosition,leg:PositionLeg):boolean {
  return exchange===leg.exchange&&row.symbol===leg.symbol&&row.side===leg.side&&
    (leg.accountPositionKey===undefined||accountPositionKey(exchange,row)===leg.accountPositionKey);
}
