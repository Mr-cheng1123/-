import type {EntryExecutionProgress} from './types.js';

const nonnegative=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
const safeReason=(reason:string)=>reason.replace(/(https?:\/\/)[^\s/@]+@/gi,'$1[已隐藏]@')
  .replace(/((?:api[_-]?key|secret|signature|passphrase|token|authorization)["']?\s*[:=]\s*["']?)[^\s,"'&}]+/gi,'$1[已隐藏]').trim().slice(0,600);

/** A small execution DTO; never copy private exchange responses or unrelated position fields. */
export function copyEntryExecutionProgress(value:unknown):EntryExecutionProgress|undefined{
  if(!value||typeof value!=='object')return;
  const progress=value as EntryExecutionProgress;
  if(progress.pricing!=='best-opposite'||!nonnegative(progress.targetQuantity)||!nonnegative(progress.matchedQuantity)||
    !Number.isSafeInteger(progress.completedBatches)||progress.completedBatches<0||
    progress.stopReason!==undefined&&typeof progress.stopReason!=='string')return;
  const result:EntryExecutionProgress={pricing:'best-opposite',targetQuantity:progress.targetQuantity,
    matchedQuantity:progress.matchedQuantity,completedBatches:progress.completedBatches};
  if(progress.stopReason!==undefined)result.stopReason=safeReason(progress.stopReason);
  return result;
}

export function entryTargetReached(progress:EntryExecutionProgress):boolean{
  return progress.targetQuantity>0&&progress.matchedQuantity>=progress.targetQuantity-Math.max(1e-9,progress.targetQuantity*1e-9);
}
