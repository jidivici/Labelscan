/**
 * Compatibility exports for the historical poissonnerie UI. New code resolves the
 * profile received from authentication through businessProfiles.ts.
 */
import { BUSINESS_PROFILES, visibleBusinessProfileFor } from './businessProfiles';

export const FIELD_ORDER = BUSINESS_PROFILES.poissonnerie.fields;

export function fieldOrderForTrade(tradeCode: string | null | undefined, version?: string) {
  return visibleBusinessProfileFor(tradeCode, version).fields;
}
