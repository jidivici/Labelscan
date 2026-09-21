import { type ReactNode, useEffect, useId, useRef, useState } from 'react';

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

export function PasswordField({
  id,
  value,
  onChange,
  name,
  label = 'Mot de passe',
  autoFocus = false,
  minLength,
  hint,
  autoComplete = 'off',
  passwordRules,
  preserveAutofill = false,
  error,
  onClearError,
}: {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  name?: string;
  label?: string;
  autoFocus?: boolean;
  minLength?: number;
  hint?: string;
  autoComplete?: 'off' | 'current-password' | 'new-password';
  passwordRules?: string;
  preserveAutofill?: boolean;
  error?: string;
  onClearError?: () => void;
}) {
  const [visible, setVisible] = useState(false);
  const generatedInputId = useId();
  const inputId = id ?? generatedInputId;
  const hintId = hint ? `${inputId}-hint` : undefined;
  const errorId = error ? `${inputId}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;
  const syncTimerRef = useRef<number | undefined>(undefined);
  const inputRef = useRef<HTMLInputElement>(null);
  const valueProps = preserveAutofill ? { defaultValue: value } : { value };

  useEffect(() => () => {
    if (syncTimerRef.current !== undefined) window.clearTimeout(syncTimerRef.current);
  }, []);

  function deferChange(nextValue: string) {
    onClearError?.();
    if (syncTimerRef.current !== undefined) window.clearTimeout(syncTimerRef.current);
    syncTimerRef.current = window.setTimeout(() => {
      syncTimerRef.current = undefined;
      onChange(nextValue);
    }, 0);
  }

  function commitChange(nextValue: string) {
    onClearError?.();
    if (syncTimerRef.current !== undefined) window.clearTimeout(syncTimerRef.current);
    syncTimerRef.current = undefined;
    onChange(nextValue);
  }

  function toggleVisibility() {
    // Safari may fill the input without emitting an input event. Read the DOM
    // value before switching its type so the AutoFill value is retained and can
    // be rendered as plain text immediately.
    commitChange(inputRef.current?.value ?? value);
    setVisible((current) => !current);
  }

  return <div className="field password-field">
    <label htmlFor={inputId}>{label}</label>
    <span className="password-input">
      <input
        ref={inputRef}
        id={inputId}
        name={name}
        type={visible ? 'text' : 'password'}
        {...valueProps}
        onInput={(event) => deferChange(event.currentTarget.value)}
        onBlur={(event) => commitChange(event.currentTarget.value)}
        {...(minLength === undefined ? {} : { minLength })}
        maxLength={128}
        autoComplete={autoComplete}
        autoFocus={autoFocus}
        aria-invalid={Boolean(error)}
        aria-describedby={describedBy}
        {...(passwordRules ? { passwordrules: passwordRules } : {})}
        required
      />
      <button
        type="button"
        onClick={toggleVisibility}
        aria-label={visible ? 'Masquer le mot de passe' : 'Afficher le mot de passe'}
        aria-pressed={visible}
      >
        {visible ? 'Masquer' : 'Afficher'}
      </button>
    </span>
    {hint ? <small id={hintId}>{hint}</small> : null}
    <span id={errorId} className="field-error" aria-live="polite">{error ?? ''}</span>
  </div>;
}

export function ConfirmDialog({
  open,
  title,
  description,
  error = '',
  confirmLabel = 'Supprimer',
  busy,
  onClose,
  onConfirm,
}: {
  open: boolean;
  title: string;
  description: string;
  error?: string;
  confirmLabel?: string;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled])') ?? []);
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
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
  }, [busy, onClose, open]);

  if (!open) return null;
  return <div className="modal-backdrop" onMouseDown={() => !busy && onClose()}>
    <div ref={dialogRef} className="modal-card confirm-card" role="alertdialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId} onMouseDown={(event) => event.stopPropagation()}>
      <div className="access-mark" aria-hidden="true">!</div>
      <h2 id={titleId}>{title}</h2>
      <p id={descriptionId}>{description}</p>
      {error && <div className="confirm-dialog-message" role="alert">{error}</div>}
      <div className="form-actions">
        <button className="button secondary" type="button" autoFocus disabled={busy} onClick={onClose}>Annuler</button>
        <button className="button danger" type="button" disabled={busy} onClick={() => void onConfirm()}>{busy ? 'Suppression…' : confirmLabel}</button>
      </div>
    </div>
  </div>;
}

export function IdentityEmpty({ title, description }: { title: string; description: string }) {
  return <div className="empty-state">
    <h2>{title}</h2>
    <p>{description}</p>
  </div>;
}
