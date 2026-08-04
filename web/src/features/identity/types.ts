import type { Role, Session, Store } from '../../types';

export type IamSession = Session;

export interface IamUser {
  id: string;
  username: string;
  display_name: string;
  role: Role;
  active: boolean;
  organization_id: string | null;
  store_id: string | null;
  store_code: string | null;
  business_portal_ids: string[];
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface IamPortal {
  id: string;
  store_id: string;
  store_code: string;
  store_name: string;
  profession_code: string;
  profession_name: string;
  name: string;
  active: boolean;
}

export interface IamOverview {
  user: IamUser;
  capabilities: string[];
  scopes: string[];
  stores: Store[];
  business_portals: IamPortal[];
}

export interface ActivationGrant {
  user: IamUser;
  activation_token: string;
  expires_at: string;
}

export interface IdentityDraft {
  username: string;
  display_name: string;
}

export interface ManagerDraft extends IdentityDraft {
  business_portal_ids: string[];
}

export interface OperatorMutation {
  business_portal_id?: string;
  active?: boolean;
}
