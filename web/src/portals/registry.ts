import type { ProfessionCode } from '../types';
import { boucheriePortal } from './boucherie';
import { charcuterieTraiteurPortal } from './charcuterieTraiteur';
import { poissonneriePortal } from './poissonnerie';
import type { PortalDefinition } from './types';

export type { PortalDefinition } from './types';

export const PORTALS: Record<ProfessionCode, PortalDefinition> = {
  poissonnerie: poissonneriePortal,
  boucherie: boucheriePortal,
  charcuterie_traiteur: charcuterieTraiteurPortal,
};

function isProfessionCode(value: string | undefined): value is ProfessionCode {
  return Boolean(value && Object.hasOwn(PORTALS, value));
}

export function portalDefinition(value: string | undefined): PortalDefinition | null {
  return isProfessionCode(value) ? PORTALS[value] : null;
}
