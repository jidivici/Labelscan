import type { ReactNode } from 'react';
import { Redirect, Route, Switch, useParams } from 'wouter';

import { useAuth } from '../auth/AuthContext';
import { RequireCapability, RequireProfession, RequireSession } from '../auth/RequireAccess';
import { firstAccessibleProfession, hasCapability } from '../auth/capabilities';
import { ArrivalsPage } from '../features/arrivals/ArrivalsPage';
import { AccountPage } from '../features/account/AccountPage';
import { LoginPage } from '../features/auth/LoginPage';
import { PortalIndexPage } from '../features/portals/PortalIndexPage';
import {
  AccessDeniedPage,
  AdminWorkspacePage,
  NotFoundPage,
  SuperAdminWorkspacePage,
} from '../features/workspaces/WorkspacePages';
import { AppShell } from '../layouts/AppShell';
import { CAPABILITIES, type Capability } from '../types';

function OrganizationHome() {
  const { session } = useAuth();
  const { organizationSlug = 'labelscan' } = useParams();
  if (!session) return null;
  if (hasCapability(session, CAPABILITIES.ADMIN_WORKSPACE_VIEW)) {
    return <Redirect to={`/o/${organizationSlug}/portails/tous/arrivages`} replace />;
  }
  const profession = firstAccessibleProfession(session);
  return <Redirect to={profession ? `/o/${organizationSlug}/portails/${profession}/arrivages` : `/o/${organizationSlug}/portails`} replace />;
}

function ProtectedPage({ children, profession = false, capability }: { children: ReactNode; profession?: boolean; capability?: Capability }) {
  let content = children;
  if (capability) content = <RequireCapability capability={capability}>{content}</RequireCapability>;
  if (profession) content = <RequireProfession>{content}</RequireProfession>;
  return <RequireSession><AppShell>{content}</AppShell></RequireSession>;
}

export function ApplicationRoutes() {
  return <Switch>
    <Route path="/o/:organizationSlug/connexion"><LoginPage /></Route>
    <Route path="/o/:organizationSlug/acces-refuse">
      <ProtectedPage><AccessDeniedPage /></ProtectedPage>
    </Route>

    <Route path="/o/:organizationSlug/portails/tous/arrivages/:arrivalId">
      <ProtectedPage capability={CAPABILITIES.ADMIN_WORKSPACE_VIEW}><RequireCapability capability={CAPABILITIES.ARRIVALS_READ}><ArrivalsPage /></RequireCapability></ProtectedPage>
    </Route>
    <Route path="/o/:organizationSlug/portails/tous/arrivages">
      <ProtectedPage capability={CAPABILITIES.ADMIN_WORKSPACE_VIEW}><RequireCapability capability={CAPABILITIES.ARRIVALS_READ}><ArrivalsPage /></RequireCapability></ProtectedPage>
    </Route>
    <Route path="/o/:organizationSlug/portails/:profession/arrivages/:arrivalId">
      <ProtectedPage profession capability={CAPABILITIES.ARRIVALS_READ}><ArrivalsPage /></ProtectedPage>
    </Route>
    <Route path="/o/:organizationSlug/portails/:profession/arrivages">
      <ProtectedPage profession capability={CAPABILITIES.ARRIVALS_READ}><ArrivalsPage /></ProtectedPage>
    </Route>
    <Route path="/o/:organizationSlug/portails/:profession">
      {(params) => <Redirect to={`/o/${params.organizationSlug}/portails/${params.profession}/arrivages`} replace />}
    </Route>
    <Route path="/o/:organizationSlug/portails">
      <ProtectedPage><PortalIndexPage /></ProtectedPage>
    </Route>
    <Route path="/o/:organizationSlug/compte">
      <ProtectedPage><AccountPage /></ProtectedPage>
    </Route>
    <Route path="/o/:organizationSlug/administration">
      <ProtectedPage capability={CAPABILITIES.ADMIN_WORKSPACE_VIEW}><AdminWorkspacePage /></ProtectedPage>
    </Route>
    <Route path="/o/:organizationSlug/super-administration">
      <ProtectedPage capability={CAPABILITIES.ADMINS_MANAGE}><SuperAdminWorkspacePage /></ProtectedPage>
    </Route>
    <Route path="/o/:organizationSlug">
      <RequireSession><OrganizationHome /></RequireSession>
    </Route>
    <Route path="/"><Redirect to="/o/labelscan" replace /></Route>
    <Route><NotFoundPage /></Route>
  </Switch>;
}
