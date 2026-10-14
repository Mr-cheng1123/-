// Execution-layer tests still exercise the ordinary (non fee-only) order paths directly with a hand-built config.
// Production configs are normalised by validateConfig to the single entry rule, so these paths are not reachable there.
import { defaultConfig as appDefaults } from '../src/shared/config.js';
export { validateConfig, configSchema } from '../src/shared/config.js';
const {marginMode:_newMarginDefault,...legacyDefaults}=appDefaults;
export const defaultConfig={...legacyDefaults,feeOnly:false,dualAdvantageEnabled:false};
