import type {AppConfig} from './types.js';

export const SPREAD_WARMUP_PROFILE_VERSION='responsive-v1' as const;
export const responsiveSpreadWarmup={
  spreadLookbackMinutes:30,spreadMinSamples:6,spreadMinSpanSec:60,spreadSampleIntervalSec:15,
} as const;
const legacySpreadWarmup={...responsiveSpreadWarmup,spreadMinSamples:12,spreadMinSpanSec:120};
const warmupFields=Object.keys(responsiveSpreadWarmup) as Array<keyof typeof responsiveSpreadWarmup>;

/** Only the complete, unversioned old default profile is migrated. Partial settings and
 * every custom value retain their meaning; an explicit custom marker also protects 12/120. */
export function isLegacySpreadWarmupProfile(settings:Partial<AppConfig>):boolean {
  return settings.spreadWarmupProfile===undefined&&warmupFields.every(key=>
    Object.hasOwn(settings,key)&&settings[key]===legacySpreadWarmup[key]);
}
export function startupSpreadWarmup(settings:Partial<AppConfig>):Partial<AppConfig> {
  return isLegacySpreadWarmupProfile(settings)?
    {...settings,...responsiveSpreadWarmup,spreadWarmupProfile:SPREAD_WARMUP_PROFILE_VERSION}:{...settings};
}
/** Editing any warm-up value marks the profile custom, preventing a later restart from
 * silently replacing the user's saved observation length. */
export function spreadWarmupProfile(settings:AppConfig):NonNullable<AppConfig['spreadWarmupProfile']> {
  return settings.spreadWarmupProfile==='custom'||warmupFields.some(key=>settings[key]!==responsiveSpreadWarmup[key])?
    'custom':SPREAD_WARMUP_PROFILE_VERSION;
}
