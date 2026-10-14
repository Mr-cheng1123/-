import type { AppConfig } from './types.js';

/** Canonical JSON comparison for already validated configuration snapshots.
 * Object key insertion order is immaterial; array order and every actual
 * configuration value are retained. No hash or persisted version is needed. */
export function configConcurrencyKey(config: AppConfig): string {
  return JSON.stringify(config, (_key, value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]]));
  });
}
