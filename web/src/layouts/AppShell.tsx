import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useParams } from 'wouter';

import { useAuth } from '../auth/AuthContext';
import { canAccessProfession, hasCapability } from '../auth/capabilities';
import { PORTALS, portalDefinition } from '../portals/registry';
import { ScopeProvider, useScope } from '../scope/ScopeContext';
import { CAPABILITIES, type ProfessionCode } from '../types';
import { BrandMark } from '../BrandMark';

const ROLE_LABELS: Record<string, string> = {
  manager: 'Manager',
  admin: 'Administrateur',
  super_admin: 'Super-administrateur',
  operator: 'Opérateur',
};

export function AppShell({ children }: { children: ReactNode }) {
  return <ScopeProvider><ShellContent>{children}</ShellContent></ScopeProvider>;
}

function ShellContent({ children }: { children: ReactNode }) {
  const { session, logout } = useAuth();
  const { stores, storesLoading, selectedStoreCode, setSelectedStoreCode } = useScope();
  const { organizationSlug = 'labelscan', profession } = useParams();
  const [location, navigate] = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [mobileViewport, setMobileViewport] = useState(
    () => typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 820px)').matches,
  );
  const sidebarRef = useRef<HTMLElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const sidebarBrandRef = useRef<HTMLButtonElement>(null);
  const currentPortal = portalDefinition(profession);

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
  const portalBase = currentPortal ? `${base}/portails/${currentPortal.code}` : '';
  const retainStore = selectedStoreCode ? `?store=${encodeURIComponent(selectedStoreCode)}` : '';

  function changeProfession(next: ProfessionCode) {
    navigate(`${base}/portails/${next}/arrivages${retainStore}`);
    setMobileOpen(false);
  }

  const closeNavigation = () => setMobileOpen(false);
  const sidebarInactive = mobileViewport && !mobileOpen;
  return <div className="app-shell">
    {mobileOpen && <button className="sidebar-scrim" aria-label="Fermer le menu" tabIndex={-1} onClick={closeNavigation} />}
    <aside ref={sidebarRef} id="app-sidebar" className={`sidebar ${mobileOpen ? 'open' : ''}`} aria-label="Navigation du portail" aria-hidden={sidebarInactive || undefined} inert={sidebarInactive || undefined}>
      <button ref={sidebarBrandRef} className="sidebar-brand" onClick={() => navigate(`${base}/portails`)}>
        <BrandMark />
        <span><strong>LabelScan</strong><small>Portail professionnel</small></span>
      </button>

      <div className="scope-selectors">
        <label><span>Métier</span><select value={currentPortal?.code ?? ''} onChange={(event) => changeProfession(event.target.value as ProfessionCode)}><option value="" disabled>Choisir un portail</option>{availablePortals.map((portal) => <option key={portal.code} value={portal.code}>{portal.shortLabel}</option>)}</select></label>
        <label><span>Magasin</span><select value={selectedStoreCode} onChange={(event) => setSelectedStoreCode(event.target.value)} disabled={storesLoading || stores.length === 0}><option value="">{stores.length > 1 ? 'Tous mes magasins' : 'Périmètre attribué'}</option>{stores.map((store) => <option value={store.code} key={store.code}>{store.name}</option>)}</select></label>
      </div>

      <nav className="sidebar-nav" aria-label="Navigation principale">
        <span className="nav-heading">Suivi</span>
        <ActiveLink href={`${base}/portails${retainStore}`} exact onClick={closeNavigation}><span className="nav-symbol">◇</span>Portails</ActiveLink>
        {currentPortal && <ActiveLink href={`${portalBase}/arrivages${retainStore}`} onClick={closeNavigation}><span className="nav-symbol">▦</span>Arrivages</ActiveLink>}
        {currentPortal && hasCapability(session, CAPABILITIES.OPERATORS_MANAGE) && <ActiveLink href={`${portalBase}/operateurs${retainStore}`} onClick={closeNavigation}><span className="nav-symbol">◎</span>Opérateurs</ActiveLink>}

        {(hasCapability(session, CAPABILITIES.ADMIN_WORKSPACE_VIEW) || hasCapability(session, CAPABILITIES.ADMINS_MANAGE)) && <span className="nav-heading separated">Administration</span>}
        {hasCapability(session, CAPABILITIES.ADMIN_WORKSPACE_VIEW) && <ActiveLink href={`${base}/administration${retainStore}`} onClick={closeNavigation}><span className="nav-symbol">⌂</span>Magasins & managers</ActiveLink>}
        {hasCapability(session, CAPABILITIES.ADMINS_MANAGE) && <ActiveLink href={`${base}/super-administration${retainStore}`} onClick={closeNavigation}><span className="nav-symbol">✦</span>Administrateurs</ActiveLink>}
      </nav>

      <footer className="sidebar-footer">
        <div className="user-summary"><span className="user-avatar">{session.user.display_name.slice(0, 2).toUpperCase()}</span><span><strong>{session.user.display_name}</strong><small>{ROLE_LABELS[session.user.role] ?? 'Compte professionnel'}</small></span></div>
        <button className="logout-button" onClick={() => void logout()}>Se déconnecter <span>↗</span></button>
      </footer>
    </aside>

    <div className="main-column" aria-hidden={mobileOpen || undefined}>
      <header className="topbar">
        <button ref={menuButtonRef} className="menu-button" onClick={() => setMobileOpen(true)} aria-label="Ouvrir le menu" aria-controls="app-sidebar" aria-expanded={mobileOpen}>☰</button>
        <div className="breadcrumb"><span>{currentPortal?.label ?? 'Espaces métier'}</span><small>{location.includes('arrivages') ? 'Arrivages' : location.includes('operateurs') ? 'Opérateurs' : 'Vue d’ensemble'}</small></div>
        <div className="topbar-context"><span className="context-dot" style={{ background: currentPortal?.accent ?? '#72817f' }} /><span>{selectedStoreCode ? stores.find((store) => store.code === selectedStoreCode)?.name ?? selectedStoreCode : stores.length > 1 ? 'Tous mes magasins' : stores[0]?.name ?? 'Périmètre sécurisé'}</span></div>
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
