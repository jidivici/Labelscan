import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';

import type { IamPortal } from './types';

const PLACEHOLDER = 'Choisir un magasin et un métier';

type SelectOption = { value: string; label: string };
type MenuPosition = Pick<CSSProperties, 'bottom' | 'left' | 'maxHeight' | 'top' | 'width'>;

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
  const options: SelectOption[] = [
    { value: '', label: PLACEHOLDER },
    ...portals
      .filter((portal) => portal.active)
      .map((portal) => ({ value: portal.id, label: `${portal.store_name} · ${portal.profession_name}` })),
  ];
  return <MenuSelect
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
  return <MenuSelect
    options={stores.map((store) => ({ value: store.id, label: store.name }))}
    selected={selected}
    onChange={onChange}
    name="store-profession-scope"
    ariaLabel="Magasin"
    disabled={disabled}
  />;
}

function MenuSelect({
  options,
  selected,
  onChange,
  name,
  ariaLabel,
  inTable = false,
  disabled = false,
}: {
  options: SelectOption[];
  selected: string;
  onChange: (id: string) => void;
  name: string;
  ariaLabel: string;
  inTable?: boolean;
  disabled?: boolean;
}) {
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === selected));
  const [open, setOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState<MenuPosition>({});
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const pendingFocusIndex = useRef<number | null>(null);
  const listboxId = useId();

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const viewportMargin = 12;
    const menuGap = 6;
    const availableBelow = window.innerHeight - rect.bottom - viewportMargin;
    const availableAbove = rect.top - viewportMargin;
    const opensUpward = availableBelow < 180 && availableAbove > availableBelow;
    const availableHeight = (opensUpward ? availableAbove : availableBelow) - menuGap;
    const maxHeight = Math.max(120, Math.min(280, availableHeight));
    const width = Math.min(Math.max(rect.width, 280), window.innerWidth - (viewportMargin * 2));
    const left = Math.min(
      Math.max(viewportMargin, rect.left),
      window.innerWidth - width - viewportMargin,
    );

    setMenuPosition({
      left,
      maxHeight,
      width,
      ...(opensUpward
        ? { bottom: window.innerHeight - rect.top + menuGap, top: undefined }
        : { bottom: undefined, top: rect.bottom + menuGap }),
    });
  }, []);

  useEffect(() => {
    if (!open) return;
    updatePosition();

    const closeOnOutsidePress = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false);
    };
    const closeOnOutsideFocus = (event: FocusEvent) => {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false);
    };

    document.addEventListener('pointerdown', closeOnOutsidePress);
    document.addEventListener('focusin', closeOnOutsideFocus);
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePress);
      document.removeEventListener('focusin', closeOnOutsideFocus);
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [open, updatePosition]);

  useEffect(() => {
    if (!open || pendingFocusIndex.current === null) return;
    optionRefs.current[pendingFocusIndex.current]?.focus();
    pendingFocusIndex.current = null;
  }, [open]);

  function openAt(index: number) {
    pendingFocusIndex.current = Math.max(0, Math.min(options.length - 1, index));
    updatePosition();
    setOpen(true);
  }

  function closeAndFocusTrigger() {
    setOpen(false);
    triggerRef.current?.focus();
  }

  function handleTriggerKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (event.key === 'Escape' && open) {
      event.preventDefault();
      closeAndFocusTrigger();
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    openAt(selectedIndex);
  }

  function handleOptionKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>, index: number) {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeAndFocusTrigger();
      return;
    }
    const nextIndex = event.key === 'ArrowDown'
      ? (index + 1) % options.length
      : event.key === 'ArrowUp'
        ? (index - 1 + options.length) % options.length
        : event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? options.length - 1
            : null;
    if (nextIndex === null) return;
    event.preventDefault();
    optionRefs.current[nextIndex]?.focus();
  }

  const menu = open && <div
    ref={menuRef}
    id={listboxId}
    className="manager-portal-menu"
    role="listbox"
    aria-label={ariaLabel}
    style={menuPosition}
  >
    {options.map((option, index) => <button
      ref={(element) => { optionRefs.current[index] = element; }}
      type="button"
      role="option"
      aria-selected={option.value === selected}
      className={`manager-portal-option ${option.value === '' ? 'placeholder' : ''}`}
      key={option.value}
      onClick={() => {
        onChange(option.value);
        closeAndFocusTrigger();
      }}
      onKeyDown={(event) => handleOptionKeyDown(event, index)}
    >
      <span>{option.label}</span>
      {option.value === selected && <span className="manager-portal-check" aria-hidden="true">✓</span>}
    </button>)}
  </div>;

  return <div ref={rootRef} className={`manager-portal-select ${inTable ? 'in-table' : ''} ${open ? 'open' : ''}`}>
    <input type="hidden" name={name} value={selected} />
    <button
      ref={triggerRef}
      type="button"
      className="manager-portal-trigger"
      aria-label={ariaLabel}
      aria-controls={open ? listboxId : undefined}
      aria-haspopup="listbox"
      aria-expanded={open}
      disabled={disabled}
      onClick={() => {
        if (open) setOpen(false);
        else {
          updatePosition();
          setOpen(true);
        }
      }}
      onKeyDown={handleTriggerKeyDown}
    >
      <span className={selected ? '' : 'placeholder'}>{options[selectedIndex]?.label ?? PLACEHOLDER}</span>
      <span className="manager-portal-chevron" aria-hidden="true" />
    </button>
    {menu && createPortal(menu, document.body)}
  </div>;
}
