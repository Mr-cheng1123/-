/** The same economic decision is used before entry and when repairing a confirmed partial hedge.
 * Fees contain the actual fees already paid plus estimates for the remaining trades, counted once. */
export function evaluateTradeEconomics(input:{fundingUsd:number;spreadUsd:number;feesUsd:number;minCombinedNetUsd:number;requireSpreadPositive?:boolean}){
  const {fundingUsd,spreadUsd,feesUsd,minCombinedNetUsd,requireSpreadPositive=true}=input;
  const valid=[fundingUsd,spreadUsd,feesUsd,minCombinedNetUsd].every(Number.isFinite)&&feesUsd>=0;
  const netUsd=fundingUsd+spreadUsd-feesUsd;
  // Report each independent condition faithfully; unknown fees must not be mislabeled as negative funding.
  const fundingPositive=Number.isFinite(fundingUsd)&&fundingUsd>0;
  const spreadPositive=Number.isFinite(spreadUsd)&&spreadUsd>0;
  const netPass=valid&&netUsd>minCombinedNetUsd;
  return {valid,netUsd,fundingPositive,spreadPositive,netPass,eligible:fundingPositive&&(!requireSpreadPositive||spreadPositive)&&netPass};
}
