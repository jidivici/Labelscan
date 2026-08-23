import { DropdownSelect, type DropdownOption } from '../../components/DropdownSelect';
import type { IamPortal } from './types';

const PLACEHOLDER = 'Choisir un magasin et un métier';

export function ManagerPortalSelect({
  portals,
  selected,
  onChange,
  name,
  ariaLabel,
  inTable = false,
  disabled = false,
}: {
  portals: IamPortal[];
  selected: string;
  onChange: (id: string) => void;
  name: string;
  ariaLabel: string;
  inTable?: boolean;
  disabled?: boolean;
}) {
  const options: DropdownOption[] = [
    { value: '', label: PLACEHOLDER },
    ...portals
      .filter((portal) => portal.active)
      .map((portal) => ({ value: portal.id, label: `${portal.store_name} · ${portal.profession_name}` })),
  ];
  return <DropdownSelect
    className="manager-portal-select"
    options={options}
    selected={selected}
    onChange={onChange}
    name={name}
    ariaLabel={ariaLabel}
    inTable={inTable}
    disabled={disabled}
  />;
}

export function StoreSelect({
  stores,
  selected,
  onChange,
  disabled = false,
}: {
  stores: Array<{ id: string; name: string }>;
  selected: string;
  onChange: (id: string) => void;
  disabled?: boolean;
}) {
  return <DropdownSelect
    className="manager-portal-select"
    options={stores.map((store) => ({ value: store.id, label: store.name }))}
    selected={selected}
    onChange={onChange}
    name="store-profession-scope"
    ariaLabel="Magasin"
    disabled={disabled}
  />;
}
