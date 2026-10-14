/**
 * Margin one leg needs before entry: initial margin plus the opening and closing taker fees.
 * Shared by startup preflight, readiness, opportunity filtering and the final pre-order check so
 * the four places can never disagree about whether an account is "funded enough".
 */
export function legEntryMarginUsd(legNotionalUsd:number,leverage:number,takerFee:number):number{
  return legNotionalUsd/leverage+2*legNotionalUsd*takerFee;
}
