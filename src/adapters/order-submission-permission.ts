import {OrderNotSubmittedError} from './order-rejection.js';

/** Final synchronous veto, after native account reads and immediately before creation. */
export function assertOrderSubmissionPermission(canSubmit?:()=>boolean):void {
  if(!canSubmit)return;
  let allowed=false;try{allowed=canSubmit()===true;}catch{/* A failed local permit is a proven no-send veto. */}
  if(!allowed)throw new OrderNotSubmittedError('Order submission permission changed before creation','ORDER_SUBMISSION_PERMISSION_CHANGED',
    '订单提交前原成交预算、交易许可或盘口已变化，本次未发送创建请求');
}
