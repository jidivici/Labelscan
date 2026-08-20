/**
 * Compatibility exports for the historical poissonnerie UI. New code resolves the
 * profile received from authentication through businessProfiles.ts.
 */
import { BUSINESS_PROFILES, businessProfileFor } from './businessProfiles';

export const FIELD_ORDER = BUSINESS_PROFILES.poissonnerie.fields;

export function fieldOrderForTrade(tradeCode: string | null | undefined) {
  return businessProfileFor(tradeCode).fields;
}
