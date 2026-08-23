import {
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from 'react';
import { Link, useLocation, useParams } from 'wouter';

import { useAuth } from '../auth/AuthContext';
import { canAccessProfession, firstAccessibleProfession, hasCapability } from '../auth/capabilities';
import { PORTALS, portalDefinition } from '../portals/registry';
import { ScopeProvider, useScope } from '../scope/ScopeContext';
import { CAPABILITIES, type ProfessionCode } from '../types';
import { BrandMark } from '../BrandMark';
import { DropdownSelect } from '../components/DropdownSelect';

const ROLE_LABELS: Record<string, string> = {
  manager: 'Manager',
  admin: 'Administrateur',
  super_admin: 'Super-administrateur',
};

export function AppShell({ children }: { children: ReactNode }) {
  return <ScopeProvider><ShellContent>{children}</ShellContent></ScopeProvider>;
}

function ShellContent({ children }: { children: ReactNode }) {
  const { session, logout } = useAuth();
  const { stores, storesLoading, selectedStoreCode, setSelectedStoreCode } = useScope();
  const { organizationSlug = 'labelscan', profession: routeProfession } = useParams();
  const [location, navigate] = useLocation();
  const profession = routeProfession ?? (location.includes('/portails/tous/') ? 'tous' : undefined);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [mobileViewport, setMobileViewport] = useState(
    () => typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 820px)').matches,
  );
  const sidebarRef = useRef<HTMLElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const sidebarBrandRef = useRef<HTMLButtonElement>(null);
  const currentPortal = portalDefinition(profession);
  const administrationWorkspace = location.includes('/administration');
  const allProfessions = profession === 'tous';

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia('(max-width: 820px)');
    const updateViewport = (event: MediaQueryListEvent) => {
      setMobileViewport(event.matches);
      if (!event.matches) setMobileOpen(false);
    };
    media.addEventListener('change', updateViewport);
    return () => media.removeEventListener('change', updateViewport);
  }, []);

  useEffect(() => {
    if (!mobileOpen) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : menuButtonRef.current;

    function focusableElements() {
      return Array.from(sidebarRef.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ) ?? []);
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        setMobileOpen(false);
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = focusableElements();
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', handleKeyDown);
    sidebarBrandRef.current?.focus();
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      previouslyFocused?.focus();
    };
  }, [mobileOpen]);

  if (!session) return null;

  const availablePortals = Object.values(PORTALS).filter((portal) => canAccessProfession(session, portal.code));
  const base = `/o/${organizationSlug}`;
  const retainStore = selectedStoreCode ? `?store=${encodeURIComponent(selectedStoreCode)}` : '';
  const defaultProfession = firstAccessibleProfession(session);
  const canSelectScope = session.user.role === 'admin' || session.user.role === 'super_admin';
  const arrivalsPath = allProfessions
    ? `${base}/portails/tous/arrivages`
    : currentPortal
      ? `${base}/portails/${currentPortal.code}/arrivages`
      : canSelectScope
        ? `${base}/portails/tous/arrivages`
        : defaultProfession
          ? `${base}/portails/${defaultProfession}/arrivages`
          : `${base}/portails`;
  const assignedStore = stores[0]?.name ?? '';
  const homePath = canSelectScope
    ? `${base}/portails/tous/arrivages${retainStore}`
    : defaultProfession
      ? `${base}/portails/${defaultProfession}/arrivages${retainStore}`
      : `${base}/portails${retainStore}`;

  function changeProfession(next: ProfessionCode | 'tous') {
    navigate(`${base}/portails/${next}/arrivages${retainStore}`);
    setMobileOpen(false);
  }

  const closeNavigation = () => setMobileOpen(false);
  const sidebarInactive = mobileViewport && !mobileOpen;
  return <div className="app-shell">
    {mobileOpen && <button type="button" className="sidebar-scrim" aria-label="Fermer le menu" tabIndex={-1} onClick={closeNavigation} />}
    <aside ref={sidebarRef} id="app-sidebar" className={`sidebar ${mobileOpen ? 'open' : ''}`} aria-label="Navigation du portail" aria-hidden={sidebarInactive || undefined} inert={sidebarInactive || undefined}>
      <button ref={sidebarBrandRef} type="button" className="sidebar-brand" onClick={() => navigate(homePath)}>
        <BrandMark />
        <span><strong>LabelScan</strong><small>Traçabilité</small></span>
      </button>

      <div className="scope-selectors">
        {canSelectScope
          ? <SidebarScopeSelect
              label="Métier"
              placeholder="Choisir un métier"
              value={administrationWorkspace || allProfessions || !currentPortal ? 'tous' : currentPortal.code}
              options={[{ value: 'tous', label: 'Tous les métiers' }, ...availablePortals.map((portal) => ({ value: portal.code, label: portal.shortLabel }))]}
              onChange={(next) => changeProfession(next as ProfessionCode | 'tous')}
            />
          : currentPortal && <div className="scope-value"><span>Métier</span><strong>{currentPortal.shortLabel}</strong></div>}
        {canSelectScope
          ? <SidebarScopeSelect
              label="Magasin"
              placeholder="Tous les magasins"
              value={selectedStoreCode}
              options={[{ value: '', label: 'Tous les magasins' }, ...stores.map((store) => ({ value: store.code, label: store.name }))]}
              disabled={storesLoading || stores.length === 0}
              onChange={setSelectedStoreCode}
            />
          : assignedStore && <div className="scope-value"><span>Magasin</span><strong>{assignedStore}</strong></div>}
      </div>

      <nav className="sidebar-nav" aria-label="Navigation principale">
        <ActiveLink href={`${arrivalsPath}${retainStore}`} onClick={closeNavigation}>Arrivages</ActiveLink>

        {hasCapability(session, CAPABILITIES.ADMIN_WORKSPACE_VIEW) && <ActiveLink href={`${base}/administration${retainStore}`} onClick={closeNavigation}>Équipe & portails</ActiveLink>}
        {hasCapability(session, CAPABILITIES.ADMINS_MANAGE) && <ActiveLink href={`${base}/super-administration${retainStore}`} onClick={closeNavigation}>Administrateurs</ActiveLink>}
      </nav>

      <footer className="sidebar-footer">
        <div className="user-summary"><span className="user-avatar">{session.user.username.slice(0, 2).toUpperCase()}</span><span><strong>{session.user.username}</strong><small>{ROLE_LABELS[session.user.role] ?? 'Compte professionnel'}</small></span></div>
        <Link href={`${base}/compte`} className="account-link" onClick={closeNavigation}>Mon compte</Link>
        <button type="button" className="logout-button" onClick={() => void logout()}>Se déconnecter</button>
      </footer>
    </aside>

    <div className="main-column" aria-hidden={mobileOpen || undefined}>
      <header className="topbar">
        <button ref={menuButtonRef} type="button" className="menu-button" onClick={() => setMobileOpen(true)} aria-label="Ouvrir le menu" aria-controls="app-sidebar" aria-expanded={mobileOpen}><span /><span /><span /></button>
        <div className="breadcrumb"><strong>{location.includes('administration') ? 'Administration' : allProfessions ? 'Tous les métiers' : currentPortal?.label ?? 'Portails'}</strong></div>
        {(canSelectScope || assignedStore) && <div className="topbar-context"><span className="context-dot" style={{ background: currentPortal?.accent ?? (allProfessions ? '#087f72' : '#72817f') }} /><span>{canSelectScope ? (selectedStoreCode ? stores.find((store) => store.code === selectedStoreCode)?.name ?? selectedStoreCode : 'Tous les magasins') : assignedStore}</span></div>}
      </header>
      <main className="main-content">{children}</main>
    </div>
  </div>;
}

function ActiveLink({ href, children, onClick, exact = false }: { href: string; children: ReactNode; onClick: () => void; exact?: boolean }) {
  const path = href.split('?')[0];
  const [location] = useLocation();
  const active = exact ? location === path : location === path || location.startsWith(`${path}/`);
  return <Link href={href} className={active ? 'active' : ''} onClick={onClick}>{children}</Link>;
}

type ScopeOption = { value: string; label: string };

function SidebarScopeSelect({ label, placeholder, value, options, disabled = false, onChange }: {
  label: string;
  placeholder: string;
  value: string;
  options: ScopeOption[];
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  return <DropdownSelect
    className="scope-dropdown"
    options={options}
    selected={value}
    onChange={onChange}
    ariaLabel={label}
    placeholder={placeholder}
    label={label}
    disabled={disabled}
    portalMenu={false}
  />;
}
