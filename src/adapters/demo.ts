import type { AppConfig, ExchangeAdapter, ExchangeId, MarketSnapshot, OrderRequest, OrderResult } from '../shared/types.js';

const PRICE:Record<string,number> = {BTC:67250, ETH:3480, SOL:148, XRP:0.59, DOGE:0.112, AVAX:27.5, LINK:14.2, SUI:1.62, ADA:0.38, DOT:4.5};
const ORDER = ['binance','bybit','okx','gate','bitget'];

/** Synthetic market data only. Execution is owned by the paper broker, never this adapter. */
export class DemoAdapter implements ExchangeAdapter {
  private readonly epoch:number;
  constructor(public readonly id:ExchangeId, private config:AppConfig, epoch = Date.now()) { this.epoch = epoch; }
  async fetchSnapshots(bases:string[]):Promise<MarketSnapshot[]> {
    const now = Date.now(), venue = ORDER.indexOf(this.id), cycle = this.config.demoSettlementSec * 1000;
    const nextFundingTime = this.epoch + (Math.floor((now-this.epoch)/cycle)+1)*cycle;
    return bases.map((base,i)=> {
      const seed = [...base].reduce((a,c)=>a+c.charCodeAt(0),0);
      const reference = (PRICE[base] ?? (seed % 100 + 5)) * (1+Math.sin(now/90000+seed)*0.00015);
      const markPrice = reference * (1 + (venue-1.5)*0.00007 + Math.sin(now/40000+venue+i)*0.00001);
      // Intentionally generous synthetic opportunities make the entire settlement lifecycle visible.
      const rates = [0.00008,0.0072,0.0003,0.0045];
      const fundingRate = rates[(venue+i)%4] * (1+0.02*Math.sin(now/60000+i));
      const step = base === 'BTC' ? 0.00001 : base === 'ETH' ? 0.0001 : 0.001;
      const liquidity = i < 6 ? 500000 : 20000;
      const levels = Array.from({length:30},(_,n)=> ({price:markPrice*(1+(n+1)*0.00002),quantity:liquidity/markPrice/30}));
      return {exchange:this.id,base,symbol:`${base}/USDT:USDT`,timestamp:now,markPrice,indexPrice:reference,
        fundingRate,nextFundingTime,intervalHours:8,predictedFundingRate:fundingRate*0.98,
        fundingHistory:[fundingRate*0.94,fundingRate*0.97,fundingRate],
        asks:levels,bids:levels.map((x,n)=>({...x,price:markPrice*(1-(n+1)*0.00002)})),
        openInterestUsd:150000000/(i+1),volume24hUsd:500000000/(i+1),quantityStep:step,minQuantity:step,
        minNotional:5,contractSize:1,source:'demo' as const};
    });
  }
  async fetchAccount() { return {freeUsd:this.config.initialBalanceUsd,equityUsd:this.config.initialBalanceUsd,positions:[]}; }
  async prepareTrading():Promise<void> { throw new Error('Demo data cannot enable live trading'); }
  async placeOrder(_request:OrderRequest):Promise<OrderResult> { throw new Error('Demo adapter cannot submit orders; use the paper broker'); }
  async reconcileOrder(_request:OrderRequest):Promise<OrderResult> { throw new Error('Demo adapter has no exchange orders'); }
  async cancelOrder():Promise<void> { throw new Error('Demo adapter has no exchange orders'); }
  async fetchFundingPayments() { return []; }
  async close() {}
}
