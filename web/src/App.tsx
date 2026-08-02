import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';

import { ApiProblem, organizationSlug, request } from './api';
import type { Arrival, ArrivalDetail, Role, Session, Store, User } from './types';

const SESSION_KEY = 'labelscan.web-session.v2';
const FIELD_LABELS: Record<string, string> = {
  commercial_designation: 'Désignation commerciale',
  scientific_name: 'Nom scientifique',
  producer_name: 'Producteur',
  reseller_brand: 'Revendeur / marque',
  batch_number: 'Numéro de lot',
  origin_country: 'Pays d’origine',
  FAO_area: 'Zone FAO',
  production_method: 'Mode de production',
  fishing_gear_or_farming_method: 'Engin de pêche / élevage',
  expiry_date: 'Date limite',
  packaging_date: 'Date de conditionnement',
  storage_temperature: 'Température',
  allergens: 'Allergènes',
  health_mark: 'Estampille sanitaire',
  weight: 'Poids',
  price: 'Prix',
  gtin: 'GTIN',
};
const FIELD_GROUPS = [
  { title: 'Identification du produit', fields: ['commercial_designation', 'scientific_name', 'producer_name', 'reseller_brand'] },
  { title: 'Provenance et production', fields: ['origin_country', 'FAO_area', 'production_method', 'fishing_gear_or_farming_method'] },
  { title: 'Traçabilité réglementaire', fields: ['batch_number', 'health_mark', 'gtin'] },
  { title: 'HACCP, dates et conservation', fields: ['packaging_date', 'expiry_date', 'storage_temperature', 'allergens'] },
  { title: 'Données commerciales', fields: ['weight', 'price'] },
] as const;

function displayFieldValue(name: string, value: string | null | undefined): string {
  if (!value) return 'Non renseigné';
  if (name === 'production_method') {
    return value === 'wild_caught' ? 'Pêche sauvage' : value === 'farmed' ? 'Élevage' : value;
  }
  if ((name === 'expiry_date' || name === 'packaging_date') && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [year, month, day] = value.split('-');
    return `${day}/${month}/${year}`;
  }
  return value;
}

function storeName(stores: Store[], code: string | null, ownStoreName?: string | null): string {
  if (!code) return 'Magasin non renseigné';
  return stores.find((store) => store.code === code)?.name ?? ownStoreName ?? 'Magasin non renseigné';
}

function readSession(): Session | null {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(SESSION_KEY) ?? 'null') as Session | null;
    if (!parsed || parsed.expiresAt <= Date.now()) return null;
    return parsed;
  } catch {
    return null;
  }
}

function Login({ onSession }: { onSession: (session: Session) => void }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    setBusy(true);
    setError('');
    try {
      const result = await request<{
        access_token: string;
        expires_in: number;
        user: Session['user'];
      }>(`/v1/o/${encodeURIComponent(organizationSlug())}/auth/login`, null, {
        method: 'POST',
        body: JSON.stringify({
          username: values.get('username'),
          password: values.get('password'),
        }),
      });
      onSession({
        token: result.access_token,
        expiresAt: Date.now() + result.expires_in * 1000,
        user: result.user,
      });
    } catch (cause) {
      setError(cause instanceof ApiProblem ? cause.message : 'Connexion impossible');
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="login">
      <form className="login-card" onSubmit={submit}>
        <img src="/backoffice/assets/labelscan-logo.png" alt="LabelScan" />
        <h1>LabelScan</h1>
        {error && <p className="notice error">{error}</p>}
        <label>Identifiant<input name="username" autoComplete="username" required autoFocus /></label>
        <label>Mot de passe<input name="password" type="password" autoComplete="current-password" required /></label>
        <button className="primary" disabled={busy}>{busy ? 'Connexion…' : 'Se connecter'}</button>
      </form>
    </main>
  );
}

function SecureImage({ arrival, session }: { arrival: Arrival; session: Session }) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (!arrival.photo_available) return;
    let active = true;
    let objectUrl = '';
    fetch(`/v1/arrivals/${arrival.batch_id}/image`, {
      headers: { Authorization: `Bearer ${session.token}` },
    })
      .then((response) => response.ok ? response.blob() : Promise.reject())
      .then((blob) => {
        objectUrl = URL.createObjectURL(blob);
        if (active) setUrl(objectUrl);
      })
      .catch(() => undefined);
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [arrival.batch_id, arrival.photo_available, session.token]);
  return url ? <img className="arrival-photo" src={url} alt="" /> : <div className="photo-placeholder">Photo</div>;
}

function SecureDetailImage({ detail, session }: { detail: ArrivalDetail; session: Session }) {
  const arrival: Arrival = {
    batch_id: detail.batch_id,
    store_code: detail.store_code,
    product_name: detail.fields.commercial_designation,
    scientific_name: detail.fields.scientific_name,
    gtin: detail.fields.gtin,
    lot_code: detail.fields.batch_number ?? '',
    supplier_name: detail.fields.reseller_brand,
    status: detail.status,
    fao_area_code: detail.fields.FAO_area,
    production_method: detail.fields.production_method,
    use_by: detail.fields.expiry_date,
    packaging_date: detail.fields.packaging_date,
    recorded_at: detail.recorded_at,
    photo_available: detail.photo_available,
  };
  return <SecureImage arrival={arrival} session={session} />;
}

function ArrivalDetailSheet({ detail, session, storeLabel, onClose }: { detail: ArrivalDetail; session: Session; storeLabel: string; onClose: () => void }) {
  const productName = detail.fields.commercial_designation || 'Produit sans désignation';
  const scientificName = detail.fields.scientific_name;
  const producer = detail.fields.producer_name || detail.fields.reseller_brand;
  const chips = [
    detail.fields.batch_number ? `Lot ${detail.fields.batch_number}` : 'Lot non renseigné',
    detail.fields.FAO_area ? `FAO ${detail.fields.FAO_area}` : null,
    detail.fields.production_method ? displayFieldValue('production_method', detail.fields.production_method) : null,
  ].filter(Boolean);

  return (
    <aside className="drawer detail-drawer" role="dialog" aria-modal="true" aria-label="Fiche arrivage">
      <div className="drawer-head detail-drawer-head">
        <span className="detail-eyebrow">Produit enregistré</span>
        <button onClick={onClose} aria-label="Fermer">×</button>
      </div>
      <div className="detail-photo"><SecureDetailImage detail={detail} session={session} /></div>
      <div className="detail-identity">
        <h2>{productName}</h2>
        {(scientificName || producer) && <p>{scientificName || producer}</p>}
        <div className="detail-chips">{chips.map((chip) => <span key={chip}>{chip}</span>)}</div>
        <div className="detail-meta">
          <span>{storeLabel}</span>
          <span>{new Date(detail.updated_at).toLocaleDateString('fr-FR')}</span>
        </div>
      </div>
      <div className="detail-groups">
        {FIELD_GROUPS.map((group) => (
          <section className="detail-group" key={group.title}>
            <div className="detail-group-title"><h3>{group.title}</h3></div>
            <dl>{group.fields.map((name, index) => (
              <div
                className={index === group.fields.length - 1 ? 'detail-field detail-field-last' : 'detail-field'}
                key={name}
              >
                <dt>{FIELD_LABELS[name]}</dt>
                <dd>{displayFieldValue(name, detail.fields[name])}</dd>
              </div>
            ))}</dl>
          </section>
        ))}
      </div>
    </aside>
  );
}

function SearchBar({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return <input className="search" type="search" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />;
}

function Catalog({ session, stores, ownStoreName }: { session: Session; stores: Store[]; ownStoreName?: string | null }) {
  const [items, setItems] = useState<Arrival[]>([]);
  const [query, setQuery] = useState('');
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [store, setStore] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [detail, setDetail] = useState<ArrivalDetail>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const labelForStore = useCallback((code: string | null) => storeName(stores, code, ownStoreName), [ownStoreName, stores]);
  const load = useCallback(async () => {
    const params = new URLSearchParams({ limit: '200' });
    if (query.trim()) params.set('q', query.trim());
    if (store) params.set('store_code', store);
    if (from) params.set('date_from', from);
    if (to) params.set('date_to', to);
    setLoading(true);
    try {
      const page = await request<{ items: Arrival[] }>('/v1/arrivals?' + params, session);
      setItems(page.items);
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Chargement impossible');
    } finally {
      setLoading(false);
    }
  }, [from, query, session, store, to]);
  useEffect(() => { void load(); }, [load]);
  async function open(id: string) {
    setDetail(await request<ArrivalDetail>(`/v1/arrivals/${id}`, session));
  }
  return (
    <section>
      <div className="page-heading"><div><h1>Arrivages</h1><p>{items.length} produit{items.length > 1 ? 's' : ''} enregistré{items.length > 1 ? 's' : ''}</p></div></div>
      <div className="toolbar">
        <SearchBar value={query} onChange={setQuery} placeholder="Rechercher par produit, lot, GTIN ou fournisseur" />
        <button className="secondary" onClick={() => setFiltersOpen(!filtersOpen)}>Filtres</button>
      </div>
      {filtersOpen && <div className="filters">
        {session.user.role === 'admin' && <label>Magasin<select value={store} onChange={(e) => setStore(e.target.value)}><option value="">Tous</option>{stores.map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}</select></label>}
        <label>Du<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label>Au<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <button className="text-button" onClick={() => { setStore(''); setFrom(''); setTo(''); }}>Réinitialiser</button>
      </div>}
      {error && <p className="notice error">{error}</p>}
      {loading ? (
        <div className="empty" aria-live="polite">Chargement des arrivages…</div>
      ) : (
        <>
          <div className="arrival-grid">{items.map((arrival) =>
            <button className="arrival-card" key={arrival.batch_id} onClick={() => void open(arrival.batch_id)}>
              <SecureImage arrival={arrival} session={session} />
              <span className="arrival-copy">
                <strong>{arrival.product_name || 'Produit sans désignation'}</strong>
                <em>{arrival.scientific_name || arrival.supplier_name || 'Information non renseignée'}</em>
                <span className="meta">{[arrival.lot_code && `Lot ${arrival.lot_code}`, labelForStore(arrival.store_code), new Date(arrival.recorded_at).toLocaleDateString('fr-FR')].filter(Boolean).join(' · ')}</span>
              </span>
            </button>
          )}</div>
          {items.length === 0 && !error && <div className="empty">Aucun arrivage pour ces critères.</div>}
        </>
      )}
      {detail && <div className="drawer-backdrop detail-backdrop" onMouseDown={() => setDetail(undefined)}>
        <div onMouseDown={(e) => e.stopPropagation()}>
          <ArrivalDetailSheet detail={detail} session={session} storeLabel={labelForStore(detail.store_code)} onClose={() => setDetail(undefined)} />
        </div>
      </div>}
    </section>
  );
}

function UserForm({ stores, onSave, onClose }: { stores: Store[]; onSave: (body: object) => Promise<void>; onClose: () => void }) {
  const [role, setRole] = useState<Role>('operator');
  return <div className="drawer-backdrop" onMouseDown={onClose}><form className="drawer form-drawer" onMouseDown={(e) => e.stopPropagation()} onSubmit={(event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    void onSave({ display_name: data.get('display_name'), username: data.get('username'), password: data.get('password'), role, store_code: role === 'operator' ? data.get('store_code') : null });
  }}>
    <div className="drawer-head"><h2>Nouvel utilisateur</h2><button type="button" onClick={onClose}>×</button></div>
    <label>Nom affiché<input name="display_name" required /></label>
    <label>Identifiant<input name="username" required /></label>
    <label>Mot de passe<input name="password" type="password" required /></label>
    <label>Rôle<select value={role} onChange={(e) => setRole(e.target.value as Role)}><option value="operator">Opérateur</option><option value="admin">Administrateur</option></select></label>
    {role === 'operator' && <label>Magasin<select name="store_code" required><option value="">Sélectionner</option>{stores.filter((s) => s.active).map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}</select></label>}
    <button className="primary">Créer le compte</button>
  </form></div>;
}

function Users({ session, stores }: { session: Session; stores: Store[] }) {
  const [items, setItems] = useState<User[]>([]);
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const load = useCallback(() => request<{ items: User[] }>('/v1/users?limit=200', session).then((page) => setItems(page.items)).catch((e) => setError(e.message)), [session]);
  useEffect(() => { void load(); }, [load]);
  const visible = useMemo(() => items.filter((u) => `${u.display_name} ${u.username} ${storeName(stores, u.store_code)}`.toLowerCase().includes(query.toLowerCase())), [items, query, stores]);
  async function create(body: object) {
    try {
      await request('/v1/users', session, { method: 'POST', body: JSON.stringify(body) });
      setCreating(false); await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Création impossible'); }
  }
  async function toggle(user: User) {
    await request(`/v1/users/${user.id}`, session, { method: 'PATCH', body: JSON.stringify({ active: !user.active }) });
    await load();
  }
  return <section>
    <div className="page-heading"><div><h1>Utilisateurs</h1><p>{visible.length} compte{visible.length > 1 ? 's' : ''}</p></div><button className="primary" onClick={() => setCreating(true)}>Nouvel utilisateur</button></div>
    <SearchBar value={query} onChange={setQuery} placeholder="Rechercher un utilisateur" />
    {error && <p className="notice error">{error}</p>}
    <div className="card-list">{visible.map((user) => <article className="entity-card" key={user.id}><div className="avatar">{user.display_name.slice(0, 2).toUpperCase()}</div><div className="entity-copy"><strong>{user.display_name}</strong><span className="break">{user.username}</span><small>{user.role === 'admin' ? 'Administrateur' : `Opérateur · ${storeName(stores, user.store_code)}`}</small></div><span className={`status ${user.active ? '' : 'off'}`}>{user.active ? 'Actif' : 'Désactivé'}</span><button className="secondary" onClick={() => void toggle(user)}>{user.active ? 'Désactiver' : 'Réactiver'}</button></article>)}</div>
    {creating && <UserForm stores={stores} onSave={create} onClose={() => setCreating(false)} />}
  </section>;
}

function Stores({ session, stores, reload }: { session: Session; stores: Store[]; reload: () => Promise<void> }) {
  const [name, setName] = useState(''); const [code, setCode] = useState('');
  async function create(event: FormEvent) {
    event.preventDefault();
    await request('/v1/stores', session, { method: 'POST', body: JSON.stringify({ code, name }) });
    setCode(''); setName(''); await reload();
  }
  return <section><div className="page-heading"><div><h1>Magasins</h1><p>{stores.length} établissement{stores.length > 1 ? 's' : ''}</p></div></div>
    <form className="inline-form" onSubmit={create}><label>Code interne<input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} required /></label><label>Nom du magasin<input value={name} onChange={(e) => setName(e.target.value)} required /></label><button className="primary">Ajouter</button></form>
    <div className="card-list">{stores.map((store) => <article className="entity-card" key={store.code}><div className="avatar store-avatar">⌂</div><div className="entity-copy"><strong>{store.name}</strong></div><span className={`status ${store.active ? '' : 'off'}`}>{store.active ? 'Actif' : 'Désactivé'}</span></article>)}</div>
  </section>;
}

export function App() {
  const [session, setSession] = useState<Session | null>(readSession);
  const [tab, setTab] = useState<'catalog' | 'users' | 'stores'>('catalog');
  const [stores, setStores] = useState<Store[]>([]);
  const [ownStoreName, setOwnStoreName] = useState<string | null>(null);
  function saveSession(next: Session) {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(next));
    setTab('catalog');
    setSession(next);
  }
  const loadStores = useCallback(async () => {
    if (!session) {
      setStores([]);
      setOwnStoreName(null);
      return;
    }
    if (session.user.role === 'admin') {
      setOwnStoreName(null);
      setStores(await request<Store[]>('/v1/stores', session));
      return;
    }
    setStores([]);
    try {
      const currentStore = await request<{ name: string }>('/v1/stores/current', session);
      setOwnStoreName(currentStore.name);
    } catch {
      setOwnStoreName(null);
    }
  }, [session]);
  useEffect(() => { void loadStores(); }, [loadStores]);
  if (!session) return <Login onSession={saveSession} />;
  const admin = session.user.role === 'admin';
  return <div className="shell">
    <header className="header"><button className="brand" onClick={() => setTab('catalog')}><img src="/backoffice/assets/labelscan-logo.png" alt="" /><strong>LabelScan</strong></button>
      <nav><button className={tab === 'catalog' ? 'active' : ''} onClick={() => setTab('catalog')}>Arrivages</button>{admin && <button className={tab === 'users' ? 'active' : ''} onClick={() => setTab('users')}>Utilisateurs</button>}{admin && <button className={tab === 'stores' ? 'active' : ''} onClick={() => setTab('stores')}>Magasins</button>}</nav>
      <div className="account"><span>{session.user.display_name}</span><button className="text-button" onClick={() => { sessionStorage.removeItem(SESSION_KEY); setSession(null); }}>Déconnexion</button></div>
    </header>
    <main className="content">{tab === 'catalog' && <Catalog session={session} stores={stores} ownStoreName={ownStoreName} />}{tab === 'users' && admin && <Users session={session} stores={stores} />}{tab === 'stores' && admin && <Stores session={session} stores={stores} reload={loadStores} />}</main>
  </div>;
}
