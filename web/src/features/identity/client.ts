import { request } from '../../api';
import type {
  ActivationGrant,
  IamOverview,
  IamPortal,
  IamSession,
  IamUser,
  IdentityDraft,
  ManagerDraft,
  OperatorMutation,
} from './types';

function json(body: object): RequestInit {
  return { body: JSON.stringify(body) };
}

export function getIamOverview(session: IamSession): Promise<IamOverview> {
  return request<IamOverview>('/v1/me', session);
}

export function listManagers(session: IamSession): Promise<IamUser[]> {
  return request<IamUser[]>('/v1/managers', session);
}

export function createManager(
  session: IamSession,
  draft: ManagerDraft,
): Promise<ActivationGrant> {
  return request<ActivationGrant>('/v1/managers', session, {
    method: 'POST',
    ...json(draft),
  });
}

export function setManagerActive(
  session: IamSession,
  userId: string,
  active: boolean,
): Promise<IamUser> {
  return request<IamUser>(`/v1/managers/${encodeURIComponent(userId)}`, session, {
    method: 'PATCH',
    ...json({ active }),
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

export function listOperators(
  session: IamSession,
  portalId: string,
): Promise<IamUser[]> {
  return request<IamUser[]>(
    `/v1/portals/${encodeURIComponent(portalId)}/operators`,
    session,
  );
}

export function createOperator(
  session: IamSession,
  portalId: string,
  draft: IdentityDraft,
): Promise<ActivationGrant> {
  return request<ActivationGrant>(
    `/v1/portals/${encodeURIComponent(portalId)}/operators`,
    session,
    { method: 'POST', ...json(draft) },
  );
}

export function updateOperator(
  session: IamSession,
  portalId: string,
  userId: string,
  mutation: OperatorMutation,
): Promise<IamUser> {
  return request<IamUser>(
    `/v1/portals/${encodeURIComponent(portalId)}/operators/${encodeURIComponent(userId)}`,
    session,
    { method: 'PATCH', ...json(mutation) },
  );
}

export function resetOperatorCredential(
  session: IamSession,
  userId: string,
): Promise<ActivationGrant> {
  return request<ActivationGrant>(
    `/v1/operators/${encodeURIComponent(userId)}/credential-reset`,
    session,
    { method: 'POST' },
  );
}

export function listAdmins(session: IamSession): Promise<IamUser[]> {
  return request<IamUser[]>('/v1/admins', session);
}

export function createAdmin(
  session: IamSession,
  draft: IdentityDraft,
): Promise<ActivationGrant> {
  return request<ActivationGrant>('/v1/admins', session, {
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
