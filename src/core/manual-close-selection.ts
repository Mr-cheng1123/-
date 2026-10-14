import { EXCHANGES, type AccountPosition, type AccountState, type ExchangeId } from '../shared/types.js';

/** Frozen selection from a displayed real account row, never a synthetic Position ID. */
export interface ManualCloseLegTarget {
  exchange: ExchangeId;
  symbol: string;
  side: 'long' | 'short';
  quantity: number;
  accountPositionKey: string;
  /** Only use the exchange's actual opening timestamp, not a bill-search horizon. */
  positionOpenedAt?: number;
}

export interface SelectedManualCloseLeg { exchange: ExchangeId; position: AccountPosition }
export interface ManualCloseSelectionOptions {
  /** Server-only capability approval, after native slots were identified and their
   * exact quantities reconciled to this aggregate. Never take this from HTTP input. */
  allowNativeSplit?: ReadonlySet<ExchangeId>;
}

function positionKey(exchange: ExchangeId, row: AccountPosition): string {
  return JSON.stringify([exchange, row.symbol, row.side, row.marginMode ?? null, row.positionId ?? null]);
}

function validTarget(target: ManualCloseLegTarget): boolean {
  if (!target || !EXCHANGES.includes(target.exchange) || typeof target.symbol !== 'string' ||
    !target.symbol || target.symbol.length > 150 || target.symbol.includes('#') ||
    !['long', 'short'].includes(target.side) || !Number.isFinite(target.quantity) || target.quantity <= 0 ||
    typeof target.accountPositionKey !== 'string' || target.accountPositionKey.length > 500 ||
    target.positionOpenedAt !== undefined && (!Number.isFinite(target.positionOpenedAt) || target.positionOpenedAt <= 0)) return false;
  try {
    const key: unknown = JSON.parse(target.accountPositionKey);
    return Array.isArray(key) && key.length === 5 && key[0] === target.exchange && key[1] === target.symbol && key[2] === target.side &&
      [null, 'isolated', 'crossed'].includes(key[3]) && (key[4] === null || typeof key[4] === 'string' && key[4].length > 0 && key[4].length <= 128) &&
      JSON.stringify(key) === target.accountPositionKey;
  } catch { return false; }
}

/** Pure validation against new account reads. Empty output means the exact selected
 * directions are already flat. No order, adoption, mutation or quantity rounding occurs. */
export function selectManualCloseLegs(base: string, targets: readonly ManualCloseLegTarget[],
  accounts: ReadonlyMap<ExchangeId, AccountState>, options: ManualCloseSelectionOptions = {}): SelectedManualCloseLeg[] {
  if (typeof base !== 'string' || !base || base !== base.trim() || base.length > 64 || /[\s#]/.test(base) ||
    !Array.isArray(targets) || targets.length < 1 || targets.length > 2 || targets.some(target => !validTarget(target))) {
    throw new Error('手动平仓选择无效，请刷新实际持仓后重新选择');
  }
  if (targets.length === 2) {
    if (targets[0].exchange === targets[1].exchange || targets[0].side === targets[1].side) {
      throw new Error('双腿平仓必须选择不同交易所的一多一空，请分别选择实际持仓');
    }
    // This explicitly selects two existing holdings for reduction; same-ticker
    // asset conflicts prohibit new hedge entry, but must not prevent closing them.
  }
  const selected: SelectedManualCloseLeg[] = [];
  for (const target of targets) {
    const account = accounts.get(target.exchange);
    if (!account || !Array.isArray(account.positions)) throw new Error(`${target.exchange} 当前账户未完整读取，不能确认待平仓数量`);
    const contractRows = account.positions.filter(row => row?.symbol === target.symbol);
    if (contractRows.some(row => !['long', 'short'].includes(row.side) || !Number.isFinite(row.quantity) || row.quantity < 0)) {
      throw new Error(`${target.exchange} 合约持仓返回无效，不能将未知数量视为空仓`);
    }
    const rows = contractRows.filter(row => row.side === target.side && row.quantity > 0);
    if (!rows.length) continue;
    if (rows.length !== 1 || (rows[0].splitPositionCount ?? 1) > 1 && !options.allowNativeSplit?.has(target.exchange)) {
      throw new Error(`${target.exchange} 存在同合约同方向多个分仓，当前不能按合计数量平仓`);
    }
    const position = rows[0];
    if (typeof position.base !== 'string' || position.base.toUpperCase() !== base.toUpperCase() ||
      positionKey(target.exchange, position) !== target.accountPositionKey) {
      throw new Error(`${target.exchange} 持仓身份或保证金模式已变化，请刷新后重新选择`);
    }
    if (target.positionOpenedAt !== undefined && position.positionOpenedAt !== target.positionOpenedAt) {
      throw new Error(`${target.exchange} 当前已是另一个持仓周期，请刷新后重新选择`);
    }
    const tolerance = Math.max(1e-12, Math.max(position.quantity, target.quantity) * Number.EPSILON * 8);
    if (Math.abs(position.quantity - target.quantity) > tolerance) {
      throw new Error(`${target.exchange} 实际持仓数量已变化，请刷新后重新确认平仓数量`);
    }
    selected.push({ exchange: target.exchange, position: { ...position } });
  }
  return selected;
}
