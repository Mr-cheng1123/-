import type { AppConfig } from '../../src/shared/types';
import { entryPolicy } from './entry-policy';
import { configConcurrencyKey } from '../../src/shared/config-concurrency';

export interface SettingsDraft {
  draft: AppConfig;
  baseline: AppConfig;
  /** Freeze the version that these edits were based on, independent of polls. */
  expectedConfig: AppConfig;
  symbolsText: string;
  dirty: boolean;
  editRevision: number;
  observedKey: string;
}

export function settingsConfigKey(config: AppConfig): string {
  return configConcurrencyKey(config);
}

export function initialSettingsDraft(config: AppConfig): SettingsDraft {
  return { draft: structuredClone(config), baseline: structuredClone(config), expectedConfig: structuredClone(config),
    symbolsText: config.symbols.join(', '), dirty: false, editRevision: 0, observedKey: settingsConfigKey(config) };
}

/** Old dashboard responses after an accepted save are the same observation,
 * and must not replace the canonical configuration returned by that save. */
export function observeSettingsConfig(state: SettingsDraft, config: AppConfig): SettingsDraft {
  const observedKey = settingsConfigKey(config);
  if (observedKey === state.observedKey) return state;
  return { ...state, observedKey, baseline: structuredClone(config),
    ...(!state.dirty ? { draft: structuredClone(config), expectedConfig: structuredClone(config), symbolsText: config.symbols.join(', ') } : {}) };
}

export function changeSettingsField<K extends keyof AppConfig>(state: SettingsDraft, key: K, value: AppConfig[K]): SettingsDraft {
  let draft = { ...state.draft, [key]: value };
  // Mirror the supported execution contract in the draft, before the user saves.
  if (entryPolicy(draft) !== 'aligned') draft = { ...draft, entryExecutionMode: 'ioc' };
  return { ...state, draft, ...(!state.dirty ? { expectedConfig: structuredClone(state.baseline) } : {}), dirty: true, editRevision: state.editRevision + 1 };
}

export function changeSettingsSymbols(state: SettingsDraft, symbolsText: string): SettingsDraft {
  return { ...state, symbolsText, ...(!state.dirty ? { expectedConfig: structuredClone(state.baseline) } : {}), dirty: true, editRevision: state.editRevision + 1 };
}

export function settingsDraftForSave(state: SettingsDraft): AppConfig {
  return { ...state.draft, symbols: [...new Set(state.symbolsText.toUpperCase().split(/[,，]/).map(symbol => symbol.trim()).filter(Boolean))] };
}

export function acceptSettingsSave(state: SettingsDraft, submittedRevision: number, config: AppConfig): SettingsDraft {
  const baseline = structuredClone(config);
  if (state.editRevision !== submittedRevision) return { ...state, baseline, expectedConfig: structuredClone(config) };
  return { ...state, baseline, expectedConfig: structuredClone(config), draft: structuredClone(config), symbolsText: config.symbols.join(', '), dirty: false };
}

export function restoreSettingsDraft(state: SettingsDraft): SettingsDraft {
  return { ...state, draft: structuredClone(state.baseline), expectedConfig: structuredClone(state.baseline), symbolsText: state.baseline.symbols.join(', '), dirty: false,
    editRevision: state.editRevision + 1 };
}
