import { z } from 'zod';
import { configSchema } from './shared/config.js';
import { EXCHANGES, type AppConfig } from './shared/types.js';
import type { ManualCloseRequest } from './shared/manual-close.js';

export class LocalRequestRejected extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export const manualCloseSchema = z.object({
  operationId: z.string().regex(/^[-\w]{8,80}$/), expiresAt: z.number().finite().positive(), base: z.string().min(1).max(64),
  acknowledgement: z.enum(['CLOSE_SELECTED_POSITION', 'CLOSE_SELECTED_ACCOUNT_POSITION']),
  legs: z.array(z.object({ exchange: z.enum(EXCHANGES), symbol: z.string().min(1).max(150), side: z.enum(['long', 'short']),
    quantity: z.number().finite().positive(), accountPositionKey: z.string().min(1).max(500),
    positionOpenedAt: z.number().finite().positive().optional() }).strict()).min(1).max(2),
}).strict();

/** A fresh user choice restores only the listed identities, never the whole attention partition. */
export const selectedReconcileSchema = z.object({
  acknowledgement:z.enum(['RECONCILE_SELECTED_POSITIONS','RECONCILE_CURRENT_STRATEGY_POSITIONS']),expiresAt:z.number().finite().positive(),
  positionIds:z.array(z.string().min(1).max(150)).min(1).max(50),
  expected:z.array(z.object({
    id:z.string().min(1).max(150),base:z.string().min(1).max(64),openedAt:z.number().finite().positive(),
    longExchange:z.enum(EXCHANGES),longSymbol:z.string().min(1).max(150),longQuantity:z.number().finite().positive(),
    shortExchange:z.enum(EXCHANGES),shortSymbol:z.string().min(1).max(150),shortQuantity:z.number().finite().positive(),
  }).strict()).min(1).max(50),
}).strict();
/** Select one original hedge for independently verified external-exposure management. */
export const selectedExternalExposureRecoverySchema=z.object({
  acknowledgement:z.literal('RESTORE_SELECTED_EXTERNAL_EXPOSURE_MANAGEMENT'),expiresAt:z.number().finite().positive(),
  positionId:z.string().min(1).max(150),
  expected:z.object({base:z.string().min(1).max(64),openedAt:z.number().finite().positive(),
    longExchange:z.enum(EXCHANGES),longSymbol:z.string().min(1).max(150),longQuantity:z.number().finite().positive(),
    shortExchange:z.enum(EXCHANGES),shortSymbol:z.string().min(1).max(150),shortQuantity:z.number().finite().positive(),
  }).strict(),
}).strict();
/** One old Maker fill can authorize only its exactly selected, confirmed peer remainder. */
export const selectedMakerCloseRepairSchema=z.object({
  acknowledgement:z.enum(['REPAIR_SELECTED_MAKER_CLOSE_TAIL','REPAIR_SELECTED_MAKER_CLOSE_LOT_TAIL']),expiresAt:z.number().finite().positive(),
  positionId:z.string().min(1).max(150),parentClientOrderId:z.string().min(1).max(150),
  legacyPeerClientOrderIds:z.array(z.string().min(1).max(150)).max(20).optional(),
  feeCorrectionAcknowledgement:z.literal('RECONCILE_CONFIRMED_PEER_FEES').optional(),
  expectedPeerFeeCorrections:z.array(z.object({clientOrderId:z.string().min(1).max(150),
    bookedFeeUsd:z.number().finite(),confirmedFeeUsd:z.number().finite(),
  }).strict()).min(1).max(20).optional(),
  expected:z.object({base:z.string().min(1).max(64),openedAt:z.number().finite().positive(),
    longExchange:z.enum(EXCHANGES),longSymbol:z.string().min(1).max(150),longQuantity:z.number().finite().positive(),
    shortExchange:z.enum(EXCHANGES),shortSymbol:z.string().min(1).max(150),shortQuantity:z.number().finite().positive(),
  }).strict(),
}).strict().refine(value=>value.expectedPeerFeeCorrections===undefined?value.feeCorrectionAcknowledgement===undefined:
  value.feeCorrectionAcknowledgement==='RECONCILE_CONFIRMED_PEER_FEES',
  {message:'已确认费用更正必须同时提供明确确认与冻结的原／新费用'})
  .refine(value=>value.acknowledgement!=='REPAIR_SELECTED_MAKER_CLOSE_LOT_TAIL'||
    value.legacyPeerClientOrderIds===undefined&&value.feeCorrectionAcknowledgement===undefined&&value.expectedPeerFeeCorrections===undefined,
    {message:'最小共同尾差恢复不能混合旧订单认领或历史费用更正'});

/** A new selected exit authority leaves the listed historical IOC outcomes unknown. */
export const selectedNativeExitRecoverySchema=z.object({
  acknowledgement:z.literal('RESTORE_SELECTED_NATIVE_EXIT_MANAGEMENT'),operationId:z.string().regex(/^[-\w]{8,80}$/),
  expiresAt:z.number().finite().positive(),positionId:z.string().min(1).max(150),parentClientOrderId:z.string().min(1).max(150),
  confirmedTailParentClientOrderId:z.string().min(1).max(150).optional(),
  confirmedIocBatchId:z.string().min(1).max(250).optional(),
  unknownClientOrderIds:z.array(z.string().min(1).max(150)).min(1).max(20),
  expected:z.object({base:z.string().min(1).max(64),openedAt:z.number().finite().positive(),
    longExchange:z.enum(EXCHANGES),longSymbol:z.string().min(1).max(150),longQuantity:z.number().finite().positive(),
    shortExchange:z.enum(EXCHANGES),shortSymbol:z.string().min(1).max(150),shortQuantity:z.number().finite().positive(),
  }).strict(),
}).strict().refine(value=>!(value.confirmedIocBatchId&&value.confirmedTailParentClientOrderId),
  'IOC 尾差恢复与 Maker 尾差恢复须明确选择一种');

/** A legacy blank close is compatible only with the paper account. Every live
 * close must bind one explicit click to native slots, quantities and a deadline. */
export function parsePositionCloseRequest(mode: AppConfig['mode'], body: unknown): ManualCloseRequest | undefined {
  const acknowledgement = body && typeof body === 'object' ? (body as { acknowledgement?: unknown }).acknowledgement : undefined;
  if (acknowledgement === undefined) {
    if (mode === 'live') throw new LocalRequestRejected('页面版本已更新，请刷新并按当前账户数量重新确认平仓；未接收平仓请求', 409);
    return undefined;
  }
  return manualCloseSchema.parse(body);
}

/** expectedConfig is request metadata, never a saved strategy setting. Absence
 * preserves local tool compatibility; an explicitly invalid snapshot is rejected. */
export function parseConfigPatch(body: unknown): { partial: Partial<AppConfig>; expectedConfig?: AppConfig } {
  const record = z.record(z.string(), z.unknown()).parse(body);
  const { expectedConfig: rawExpected, ...partial } = record;
  return { partial, ...('expectedConfig' in record ? { expectedConfig: configSchema.parse(rawExpected) } : {}) };
}
