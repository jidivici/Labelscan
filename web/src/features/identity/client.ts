import { request } from '../../api';
import type {
  IamOverview,
  IamPortal,
  IamSession,
  IamUser,
  IdentityDraft,
  ManagerDraft,
} from './types';
import type { ProfessionCode, Store } from '../../types';

function json(body: object): RequestInit {
  return { body: JSON.stringify(body) };
}

export function getIamOverview(session: IamSession): Promise<IamOverview> {
  return request<IamOverview>('/v1/me', session);
}

export function changeMyPassword(
  session: IamSession,
  newPassword: string,
  currentPassword?: string,
): Promise<void> {
  const body: { new_password: string; current_password?: string } = { new_password: newPassword };
  if (currentPassword) body.current_password = currentPassword;
  return request<void>('/v1/me/password', session, {
    method: 'POST',
    ...json(body),
  });
}

export function createStore(
  session: IamSession,
  draft: { name: string; profession_codes: ProfessionCode[] },
): Promise<Store> {
  return request<Store>('/v1/stores', session, {
    method: 'POST',
    ...json(draft),
  });
}

export function setStoreActive(
  session: IamSession,
  storeCode: string,
  active: boolean,
): Promise<Store> {
  return request<Store>(`/v1/stores/${encodeURIComponent(storeCode)}`, session, {
    method: 'PATCH',
    ...json({ active }),
  });
}

export function listManagers(session: IamSession): Promise<IamUser[]> {
  return request<IamUser[]>('/v1/managers', session);
}

export function createManager(
  session: IamSession,
  draft: ManagerDraft,
): Promise<IamUser> {
  return request<IamUser>('/v1/managers', session, {
    method: 'POST',
    ...json(draft),
  });
}

export function deleteManager(session: IamSession, userId: string): Promise<void> {
  return request<void>(`/v1/managers/${encodeURIComponent(userId)}`, session, {
    method: 'DELETE',
  });
}

export function replaceManagerPortals(
  session: IamSession,
  userId: string,
  businessPortalIds: string[],
): Promise<IamUser> {
  return request<IamUser>(
    `/v1/managers/${encodeURIComponent(userId)}/portals`,
    session,
    { method: 'PATCH', ...json({ business_portal_ids: businessPortalIds }) },
  );
}

export function updateManagerAccount(
  session: IamSession,
  userId: string,
  draft: { display_name: string; new_password?: string },
): Promise<IamUser> {
  return request<IamUser>(`/v1/managers/${encodeURIComponent(userId)}/account`, session, {
    method: 'PATCH',
    ...json(draft),
  });
}

export function listAdmins(session: IamSession): Promise<IamUser[]> {
  return request<IamUser[]>('/v1/admins', session);
}

export function createAdmin(
  session: IamSession,
  draft: IdentityDraft,
): Promise<IamUser> {
  return request<IamUser>('/v1/admins', session, {
    method: 'POST',
    ...json(draft),
  });
}

export function deactivateAdmin(session: IamSession, userId: string): Promise<void> {
  return request<void>(`/v1/admins/${encodeURIComponent(userId)}`, session, {
    method: 'DELETE',
  });
}

export function listStorePortals(
  session: IamSession,
  storeId: string,
): Promise<IamPortal[]> {
  return request<IamPortal[]>(
    `/v1/stores/${encodeURIComponent(storeId)}/portals`,
    session,
  );
}

export function setStorePortalActive(
  session: IamSession,
  storeId: string,
  portalId: string,
  active: boolean,
): Promise<IamPortal> {
  return request<IamPortal>(
    `/v1/stores/${encodeURIComponent(storeId)}/portals`,
    session,
    { method: 'PUT', ...json({ portal_id: portalId, active }) },
  );
}
