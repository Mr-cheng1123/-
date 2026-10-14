import type { ExchangeId } from './types.js';

export const FUNDING_RANGES=['current','1d','7d','30d','365d'] as const;
export type FundingRange=typeof FUNDING_RANGES[number];
export type FundingStatsSource='coinglass'|'exchanges'|'demo';
export interface FundingStatsCell {
  exchange:ExchangeId;
  /** Decimal fraction, e.g. 0.0001 represents 0.01%. */
  rate:number;
  intervalHours:number|null;
  nextFundingTime:number|null;
  updatedAt:number;
  timestampKind:'exchange'|'received';
  predictedRate?:number;
  openInterestUsd?:number;
  volume24hUsd?:number;
  available:boolean;
}
export interface FundingStatsRow { base:string;cells:Partial<Record<ExchangeId,FundingStatsCell>> }
export interface FundingStatsDataset {
  source:FundingStatsSource;
  range:FundingRange;
  status:'ready'|'loading'|'not_configured'|'error'|'stale'|'unsupported';
  rows:FundingStatsRow[];
  receivedAt:number;
  lastAttemptAt:number;
  nextRefreshAt:number;
  maxAgeMs:number;
  message?:string;
  sourceUrl:string;
  marginScope:string;
}
export interface FundingStatsResponse extends FundingStatsDataset { coinglassConfigured:boolean }

export function comparableRate(cell:FundingStatsCell,range:FundingRange,basis:'native'|'8h',predicted=false):number|null{
  const rate=predicted?cell.predictedRate:cell.rate;
  if(typeof rate!=='number'||!Number.isFinite(rate))return null;
  if(range!=='current')return predicted?null:rate;
  if(basis==='native')return rate;
  return cell.intervalHours!==null&&cell.intervalHours>0?rate*8/cell.intervalHours:null;
}
export function fundingCellIsFresh(cell:FundingStatsCell,dataset:FundingStatsDataset,now=Date.now()):boolean{
  return cell.available&&now-cell.updatedAt<=dataset.maxAgeMs&&cell.updatedAt<=now+5000&&
    (dataset.range!=='current'||cell.nextFundingTime===null||cell.nextFundingTime>now);
}
export function summarizeFundingRow(row:FundingStatsRow,dataset:FundingStatsDataset,now=Date.now()){
  const current=Object.values(row.cells).filter((c):c is FundingStatsCell=>Boolean(c)&&fundingCellIsFresh(c!,dataset,now));
  const comparable=current.map(cell=>({cell,value:comparableRate(cell,dataset.range,'8h')})).filter((x):x is {cell:FundingStatsCell;value:number}=>x.value!==null).sort((a,b)=>a.value-b.value);
  const low=comparable[0],high=comparable.at(-1);
  const gap=comparable.length>=2?high!.value-low.value:null;
  const weighted=(field:'openInterestUsd'|'volume24hUsd')=>{
    if(dataset.range!=='current')return null;
    const eligible=comparable.filter(x=>Number.isFinite(x.cell[field])&&(x.cell[field]??0)>0);
    const denominator=eligible.reduce((sum,x)=>sum+x.cell[field]!,0);
    return denominator>0?eligible.reduce((sum,x)=>sum+x.value*x.cell[field]!,0)/denominator:null;
  };
  return {available:current.length,low:low?.cell.exchange??null,high:high?.cell.exchange??null,gap,
    aprPct:gap!==null&&dataset.range==='current'?gap*3*365*100:null,oiWeighted8h:weighted('openInterestUsd'),volumeWeighted8h:weighted('volume24hUsd')};
}
