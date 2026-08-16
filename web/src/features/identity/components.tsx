import { type FormEvent, type ReactNode, useEffect, useId, useRef, useState } from 'react';

import type { IamPortal, IamUser } from './types';

export const IDENTITY_PAGE_SIZE = 10;

export function CompactPager({ page, total, onChange, label }: {
  page: number;
  total: number;
  onChange: (page: number) => void;
  label: string;
}) {
  const pageCount = Math.max(1, Math.ceil(total / IDENTITY_PAGE_SIZE));
  if (pageCount <= 1) return null;
  const first = ((page - 1) * IDENTITY_PAGE_SIZE) + 1;
  const last = Math.min(page * IDENTITY_PAGE_SIZE, total);
  return <nav className="compact-pager" aria-label={`Pagination ${label}`}>
    <span>{first}–{last} sur {total}</span>
    <span className="compact-pager-controls">
      <button type="button" disabled={page <= 1} onClick={() => onChange(page - 1)} aria-label={`${label} précédents`}>‹</button>
      <span>{page}/{pageCount}</span>
      <button type="button" disabled={page >= pageCount} onClick={() => onChange(page + 1)} aria-label={`${label} suivants`}>›</button>
    </span>
  </nav>;
}

export function IdentityPanel({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return <section className="data-panel identity-panel">
    <header className="identity-panel-header">
      <h2>{title}</h2>
      {description && <p>{description}</p>}
    </header>
    {children}
  </section>;
}

export function LoadingState({ label }: { label: string }) {
  return <div className="catalog-loading" aria-live="polite">
    <div className="loader" />
    <p>{label}</p>
  </div>;
}

export function ErrorNotice({ message }: { message: string }) {
  return message ? <div className="notice error" role="alert">{message}</div> : null;
}

export function SuccessNotice({ message }: { message: string }) {
  return message ? <div className="notice success" role="status">{message}</div> : null;
}

export function ActiveBadge({ active }: { active: boolean }) {
  return <span className={`status-badge ${active ? '' : 'warning'}`}>
    {active ? 'Actif' : 'Inactif'}
  </span>;
}

export function PortalLabel({ portal }: { portal?: IamPortal }) {
  if (!portal) return <>Portail indisponible</>;
  return <>{portal.profession_name} · {portal.store_name}</>;
}

export function PasswordField({
  value,
  onChange,
  label = 'Mot de passe',
  autoFocus = false,
  minLength = 1,
  hint,
  autoComplete = 'new-password',
}: {
  value: string;
  onChange: (value: string) => void;
  label?: string;
  autoFocus?: boolean;
  minLength?: number;
  hint?: string;
  autoComplete?: 'current-password' | 'new-password';
}) {
  const [visible, setVisible] = useState(false);
  const inputId = useId();
  return <div className="field password-field">
    <label htmlFor={inputId}>{label}</label>
    <span className="password-input">
      <input
        id={inputId}
        type={visible ? 'text' : 'password'}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        minLength={minLength}
        maxLength={128}
        autoComplete={autoComplete}
        autoFocus={autoFocus}
        required
      />
      <button type="button" onClick={() => setVisible((current) => !current)} aria-label={visible ? 'Masquer le mot de passe' : 'Afficher le mot de passe'}>
        {visible ? 'Masquer' : 'Afficher'}
      </button>
    </span>
    {hint ? <small>{hint}</small> : null}
  </div>;
}

export function PasswordDialog({
  user,
  busy,
  onClose,
  onSubmit,
}: {
  user: IamUser | null;
  busy: boolean;
  onClose: () => void;
  onSubmit: (password: string) => Promise<void>;
}) {
  const [password, setPassword] = useState('');
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!user) return;
    setPassword('');
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ) ?? []);
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
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [busy, onClose, user]);

  if (!user) return null;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await onSubmit(password);
  }
  return <div className="modal-backdrop" onMouseDown={() => !busy && onClose()}>
    <div ref={dialogRef} className="modal-card" role="dialog" aria-modal="true" aria-labelledby="password-dialog-title" onMouseDown={(event) => event.stopPropagation()}>
      <header>
        <div><h2 id="password-dialog-title">Nouveau mot de passe</h2><p>{user.username}</p></div>
        <button className="icon-button" type="button" onClick={onClose} disabled={busy} aria-label="Fermer">×</button>
      </header>
      <form className="modal-form" onSubmit={(event) => void submit(event)}>
        <PasswordField value={password} onChange={setPassword} minLength={1} autoFocus />
        <div className="form-actions">
          <button className="button secondary" type="button" onClick={onClose} disabled={busy}>Annuler</button>
          <button className="button primary" disabled={busy || password.length === 0}>{busy ? 'Enregistrement…' : 'Enregistrer'}</button>
        </div>
      </form>
    </div>
  </div>;
}

export function IdentityEmpty({ title, description }: { title: string; description: string }) {
  return <div className="empty-state">
    <h2>{title}</h2>
    <p>{description}</p>
  </div>;
}
