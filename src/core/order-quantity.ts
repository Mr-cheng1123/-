/** Use the decimal values actually represented by API numbers, including scientific notation. */
const lotPlaces=new Map<number,number>(),commonLots=new Map<string,number>();
function boundedCache<K,V>(cache:Map<K,V>,key:K,value:V){
  if(cache.size>=256)cache.delete(cache.keys().next().value!);cache.set(key,value);return value;
}
function decimal(value:number):{coefficient:bigint;places:number}|undefined {
  if(!Number.isFinite(value)||value<0)return;
  const [mantissa,exponent='0']=String(value).split('e'),[whole,fraction='']=mantissa.split('.');
  const places=fraction.length-Number(exponent),coefficient=BigInt(whole+fraction);
  return places<0?{coefficient:coefficient*10n**BigInt(-places),places:0}:{coefficient,places};
}
/** A common integer grid has no fixed twelve-decimal cutoff or unsafe integer rounding. */
export function quantityGrid(values:number[]){
  const parsed=values.map(decimal);if(parsed.some(value=>!value))return;
  const decimals=Math.max(0,...parsed.map(value=>value!.places));
  return {decimals,units:parsed.map(value=>value!.coefficient*10n**BigInt(decimals-value!.places)),
    toNumber:(units:bigint)=>Number(`${units}e-${decimals}`)};
}
export function multiplyQuantity(a:number,b:number):number {
  const left=decimal(a),right=decimal(b);if(!left||!right)return NaN;
  return Number(`${left.coefficient*right.coefficient}e-${left.places+right.places}`);
}
export function quantitySubtract(a:number,b:number):number {
  const grid=quantityGrid([a,b]);return grid?grid.toNumber(grid.units[0]-grid.units[1]):NaN;
}
/** Subtract confirmed native lots without manufacturing a fractional-lot tail
 * from arithmetic ulps. Both operands must represent positive nonzero lots;
 * off-grid inputs, real tiny quantities and absent steps retain exact subtraction.
 * This does not infer whether an order filled or change a fill's cash amount. */
export function quantitySubtractOnStep(a:number,b:number,step:number):number {
  if(a>0&&b>0&&isQuantityOnStep(a,step)&&isQuantityOnStep(b,step)){
    const left=floorQuantity(a,step),right=floorQuantity(b,step);
    if(left>0&&right>0)return quantitySubtract(left,right);
  }
  return quantitySubtract(a,b);
}
export function quantityAdd(a:number,b:number):number {
  const grid=quantityGrid([a,b]);return grid?grid.toNumber(grid.units[0]+grid.units[1]):NaN;
}
/** Quantities are base coins, independent of exchange contract multipliers. */
export function floorQuantity(q:number,step:number):number {
  if(!Number.isFinite(q)||q<0||!Number.isFinite(step)||!(step>0))return NaN;
  const ratio=q/step;
  // Ordinary native lots stay on the inexpensive existing arithmetic path.
  // Decimal places, unlike significant digits, preserve large legal integers.
  if(Number.isFinite(ratio)&&ratio<=Number.MAX_SAFE_INTEGER){
    const rounded=Math.round(ratio),count=Math.abs(rounded-ratio)<=Math.min(1e-7,Number.EPSILON*Math.max(1,Math.abs(ratio))*8)?rounded:Math.floor(ratio);
    const places=lotPlaces.get(step)??boundedCache(lotPlaces,step,decimal(step)!.places);
    if(places<=100&&count*step<1e21){
      const candidate=Number((count*step).toFixed(places));
      if(candidate<=q+Math.min(step*1e-7,Number.EPSILON*Math.max(Math.abs(q),Math.abs(step))*8))return candidate;
    }
  }
  const grid=quantityGrid([q,step]);if(!grid)return NaN;
  const [quantity,lot]=grid.units;if(lot<=0n)return NaN;
  const floored=quantity/lot*lot;
  // Repair only a few machine ulps from arithmetic, never a fixed fraction of a lot.
  const next=grid.toNumber(floored+lot),tolerance=Math.min(step*1e-7,Number.EPSILON*Math.max(Math.abs(q),Math.abs(step))*8);
  return next-q<=tolerance?next:grid.toNumber(floored);
}
export function isQuantityOnStep(q:number,step:number):boolean {
  return Number.isFinite(q)&&q>=0&&Number.isFinite(step)&&step>0&&
    Math.abs(floorQuantity(q,step)-q)<=Math.min(step*1e-7,Number.EPSILON*Math.max(Math.abs(q),Math.abs(step))*8);
}
export function isLegalQuantity(q:number,step:number,minimum:number):boolean {
  return q>0&&Number.isFinite(minimum)&&minimum>=0&&
    (q>=minimum||minimum-q<=Math.min(step*1e-7,Number.EPSILON*Math.max(Math.abs(q),Math.abs(minimum),step)*8))&&isQuantityOnStep(q,step);
}
export function commonStep(a:number,b:number):number {
  if(!(Number.isFinite(a)&&Number.isFinite(b)&&a>0&&b>0))return NaN;
  const key=a<=b?`${a}:${b}`:`${b}:${a}`,cached=commonLots.get(key);if(cached!==undefined)return cached;
  const grid=quantityGrid([a,b]);if(!grid)return NaN;
  const [ai,bi]=grid.units;
  const gcd=(x:bigint,y:bigint):bigint=>y===0n?x:gcd(y,x%y);
  const lot=grid.toNumber(ai/gcd(ai,bi)*bi);
  return Number.isFinite(lot)&&lot>0?boundedCache(commonLots,key,lot):NaN;
}
