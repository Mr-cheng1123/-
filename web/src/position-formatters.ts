import { liquidationObservationLabel as originalLiquidationLabel, type ObservedLedgerLeg } from './ledger-position-metrics';

const fixedFormats = new Map<number, Intl.NumberFormat>();
const fixedFormat = (digits: number) => {
  let format = fixedFormats.get(digits);
  if (!format) { format = new Intl.NumberFormat('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits }); fixedFormats.set(digits, format); }
  return format;
};
const priceFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 8 });
const dateFormat = new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const timeFormat = new Intl.DateTimeFormat('zh-CN', { hour: 'numeric', minute: 'numeric', second: 'numeric', hour12: false });

export const positionMoney = (value: number | undefined, signed = false) => value === undefined || !Number.isFinite(value) ? '—' :
  `${value < 0 ? '−' : signed && value > 0 ? '+' : ''}$${fixedFormat(2).format(Math.abs(value))}`;
export const positionNumber = (value: number, digits = 6) => fixedFormat(digits).format(value);
export const positionPrice = (value: number | undefined) => value === undefined || !Number.isFinite(value) ? '—' : priceFormat.format(value);
export const positionDate = (value: number | undefined, missing = '尚未更新') => value ? dateFormat.format(value) : missing;
export const positionTime = (value: number | undefined, missing = '尚未更新') => value ? timeFormat.format(value) : missing;
export const positionLiquidationLabel = (leg: ObservedLedgerLeg) => leg.liquidation.status === 'available' ?
  `${fixedFormat(2).format(leg.liquidation.distancePct!)}%` : originalLiquidationLabel(leg);
