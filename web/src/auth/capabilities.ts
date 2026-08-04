import {
  CAPABILITIES,
  PROFESSION_CODES,
  type AccessOverviewPayload,
  type AuthPayload,
  type Capability,
  type ProfessionCode,
  type Role,
  type Session,
} from '../types';

const ROLE_VALUES = new Set<string>(['super_admin', 'admin', 'manager', 'operator']);
const CAPABILITY_VALUES = new Set<string>(Object.values(CAPABILITIES));
const PROFESSION_VALUES = new Set<string>(PROFESSION_CODES);

const SERVER_SCOPE_CAPABILITIES: Record<string, readonly Capability[]> = {
  'catalog:read': [CAPABILITIES.ARRIVALS_READ],
  'identity:operators:manage': [CAPABILITIES.OPERATORS_MANAGE],
  'identity:read': [CAPABILITIES.STORES_READ],
  'identity:portals:manage': [
    CAPABILITIES.ADMIN_WORKSPACE_VIEW,
    CAPABILITIES.STORES_READ,
    CAPABILITIES.STORES_MANAGE,
  ],
  'identity:managers:manage': [
    CAPABILITIES.ADMIN_WORKSPACE_VIEW,
    CAPABILITIES.MANAGER_ASSIGNMENTS_MANAGE,
  ],
  'identity:admins:manage': [
    CAPABILITIES.SUPER_ADMIN_WORKSPACE_VIEW,
    CAPABILITIES.ADMINS_MANAGE,
  ],
};

function validRole(role: string): Role {
  return ROLE_VALUES.has(role) ? role as Role : 'operator';
}

/** Build only the authenticated bearer shell. `/v1/me` remains the authority for access. */
export function sessionFromAuthPayload(payload: AuthPayload): Session {
  return {
    token: payload.access_token,
    expiresAt: Date.now() + payload.expires_in * 1000,
    user: {
      ...payload.user,
      role: validRole(payload.user.role),
      capabilities: [],
      profession_codes: [],
      accessible_stores: [],
      business_portal_ids: [],
    },
  };
}

/** Apply the persisted, server-authoritative stores, portals and role scopes. */
export function applyAccessOverview(session: Session, overview: AccessOverviewPayload): Session {
  const capabilities = new Set<Capability>([CAPABILITIES.WEB_ACCESS]);
  for (const scope of new Set([...overview.capabilities, ...overview.scopes])) {
    if (CAPABILITY_VALUES.has(scope)) capabilities.add(scope as Capability);
    for (const capability of SERVER_SCOPE_CAPABILITIES[scope] ?? []) capabilities.add(capability);
  }

  const stores = overview.stores.filter((store) => store.active);
  const portals = overview.business_portals.filter((portal) => portal.active);
  const professionCodes = portals
    .map((portal) => portal.profession_code)
    .filter((code): code is ProfessionCode => PROFESSION_VALUES.has(code));
  if (stores.length > 1) capabilities.add(CAPABILITIES.STORE_SWITCH);
  if (new Set(professionCodes).size > 1) capabilities.add(CAPABILITIES.PROFESSION_SWITCH);

  return {
    ...session,
    user: {
      ...session.user,
      capabilities: [...capabilities],
      profession_codes: [...new Set(professionCodes)],
      accessible_stores: stores,
      business_portal_ids: portals.map((portal) => portal.id),
    },
  };
}

export function hasCapability(session: Session | null, capability: Capability): boolean {
  return Boolean(session?.user.capabilities.includes(capability));
}

export function canAccessProfession(session: Session | null, profession: string): profession is ProfessionCode {
  if (!session || !PROFESSION_VALUES.has(profession)) return false;
  return session.user.profession_codes.includes(profession as ProfessionCode);
}

export function firstAccessibleProfession(session: Session): ProfessionCode | null {
  return PROFESSION_CODES.find((profession) => canAccessProfession(session, profession)) ?? null;
}
