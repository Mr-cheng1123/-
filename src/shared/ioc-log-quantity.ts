import type {IocSubmissionVetoCode} from './execution-statistics.js';

export const iocSubmissionVetoReasons:Record<IocSubmissionVetoCode,string>={
  'runtime-permission':'当前运行或交易许可变化',configuration:'执行配置变化','batch-identity':'本批次或持仓身份变化',
  'order-identity':'原订单意图变化','cash-scope':'本组现金或订单范围变化','native-authority':'限定原生减仓授权失效',
  'unresolved-order':'存在待核实原订单','native-proof-age':'原生账户与挂单证明超过有效期',book:'首档盘口价格、数量或时效变化',
  'native-fee':'账户实际手续费失效','profit-threshold':'最新返佣后盈利未超过10bps门槛','exit-condition':'本批次退出条件不再满足',
  'local-validation':'本地最终核验未通过',
};

/** Display arithmetic tails only; never round stored quantities or use the wider execution tolerance. */
export function formatIocLogQuantity(value:number):string {
  if(!Number.isFinite(value)||Number.isInteger(value))return String(value);
  const concise=Number(value.toPrecision(15));
  if(Number.isInteger(concise))return String(value);
  // Relative precision alone can erase whole units at large magnitudes. Keep
  // the absolute display change within two EPSILON too; never truncate to zero.
  return String(Math.abs(value-concise)<=Math.min(Math.abs(value),1)*Number.EPSILON*2?concise:value);
}

const numeric='(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?(?:e[+-]?[0-9]+)?';
const originalReceipt=new RegExp('^([A-Z0-9]{2,15} (?:binance|bybit|okx|gate|bitget) 对手价1 IOC '+
  '(?:减仓 |提交前核验未通过；本次未发送创建请求；|原生订单已终态，零成交（(?:cancelled|partial|filled)）；|'+
  '零成交回执未取得原生订单 ID；)(?:买入|卖出) )('+numeric+') / ('+numeric+')(.*)$');

/** Display compatibility for retained or older-backend receipt messages. Only
 * canonical JS numbers in our exact receipt templates are eligible. The raw
 * log entry, native receipt, context and all unrelated diagnostics stay intact. */
export function formatIocReceiptLogMessage(message:string):string {
  const match=originalReceipt.exec(message);
  if(!match)return message;
  const requested=Number(match[3]),filled=Number(match[2]);
  if(![filled,requested].every(Number.isFinite)||String(filled)!==match[2]||String(requested)!==match[3])return message;
  const suffix=match[4];
  const knownSuffix=match[1].includes('IOC 减仓 ')?suffix==='':
    match[1].includes('本次未发送创建请求')?suffix===''||Object.values(iocSubmissionVetoReasons).some(reason=>suffix==='；原因：'+reason):
    match[1].includes('原生订单已终态')?suffix==='，等待下一次核验':suffix==='，发送状态须按原记录核对';
  if(!knownSuffix)return message;
  return match[1]+formatIocLogQuantity(filled)+' / '+formatIocLogQuantity(requested)+suffix;
}
