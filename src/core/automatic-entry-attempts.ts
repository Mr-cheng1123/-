/** A terminal no-fill or rejected entry must not become a new POST on every websocket event.
 * Manual actions stay independent; unknown intents and existing positions have their own stronger gates. */
export class AutomaticEntryAttempts {
  private readonly nextAttempt=new Map<string,number>();
  constructor(readonly retryDelayMs=15_000){}
  ready(base:string,now=Date.now()):boolean{return Number.isFinite(now)&&now>=(this.nextAttempt.get(base)??0);}
  claim(base:string,now=Date.now()):boolean {
    if(!this.ready(base,now))return false;
    this.nextAttempt.set(base,now+this.retryDelayMs);return true;
  }
}
