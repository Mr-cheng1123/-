import type { AppConfig } from './types.js';

/** A forecast profile; it never grants exchange access or permission to submit orders. */
export function isFeeOnly(config:Pick<AppConfig,'mode'|'paperFeeOnly'|'feeOnly'>):boolean {
  return config.feeOnly===true||(config.mode==='paper'&&config.paperFeeOnly===true);
}
