import { type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export interface DropdownOption {
  value: string;
  label: string;
}

type MenuPosition = Pick<CSSProperties, 'bottom' | 'left' | 'maxHeight' | 'top' | 'width'>;

interface DropdownSelectProps {
  options: readonly DropdownOption[];
  selected: string;
  onChange: (value: string) => void;
  ariaLabel: string;
  placeholder?: string;
  label?: string;
  name?: string;
  className?: string;
  inTable?: boolean;
  disabled?: boolean;
  portalMenu?: boolean;
}

/** Shared accessible dropdown used by the sidebar, identity forms and filters. */
export function DropdownSelect({
  options,
  selected,
  onChange,
  ariaLabel,
  placeholder = 'Sélectionner',
  label,
  name,
  className = 'dropdown-select',
  inTable = false,
  disabled = false,
  portalMenu = true,
}: DropdownSelectProps) {
  const selectedIndex = options.findIndex((option) => option.value === selected);
  const selectedLabel = selectedIndex >= 0 ? options[selectedIndex].label : placeholder;
  const [open, setOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState<MenuPosition>({});
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const pendingFocusIndex = useRef<number | null>(null);
  const labelId = useId();
  const valueId = useId();
  const listboxId = useId();

  const updatePosition = useCallback(() => {
    if (!portalMenu || !triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const viewportMargin = 12;
    const menuGap = 6;
    const availableBelow = window.innerHeight - rect.bottom - viewportMargin;
    const availableAbove = rect.top - viewportMargin;
    const opensUpward = availableBelow < 180 && availableAbove > availableBelow;
    const availableHeight = (opensUpward ? availableAbove : availableBelow) - menuGap;
    const maxHeight = Math.max(120, Math.min(280, availableHeight));
    const width = Math.min(Math.max(rect.width, 220), window.innerWidth - (viewportMargin * 2));
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
  }, [portalMenu]);

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
    if (portalMenu) {
      window.addEventListener('resize', updatePosition);
      window.addEventListener('scroll', updatePosition, true);
    }
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePress);
      document.removeEventListener('focusin', closeOnOutsideFocus);
      if (portalMenu) {
        window.removeEventListener('resize', updatePosition);
        window.removeEventListener('scroll', updatePosition, true);
      }
    };
  }, [open, portalMenu, updatePosition]);

  useEffect(() => {
    if (!open || pendingFocusIndex.current === null) return;
    optionRefs.current[pendingFocusIndex.current]?.focus();
    pendingFocusIndex.current = null;
  }, [open]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  function openAt(index: number) {
    if (options.length === 0) return;
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
    openAt(selectedIndex >= 0 ? selectedIndex : event.key === 'ArrowDown' ? 0 : options.length - 1);
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
    className={`${className}-menu`}
    role="listbox"
    aria-label={ariaLabel}
    style={portalMenu ? menuPosition : undefined}
  >
    {options.map((option, index) => <button
      ref={(element) => { optionRefs.current[index] = element; }}
      type="button"
      role="option"
      aria-selected={option.value === selected}
      className={`${className}-option ${option.value === '' ? 'placeholder' : ''}`}
      key={option.value}
      onClick={() => {
        onChange(option.value);
        closeAndFocusTrigger();
      }}
      onKeyDown={(event) => handleOptionKeyDown(event, index)}
    >
      <span>{option.label}</span>
      {option.value === selected && <span className={`${className}-check`} aria-hidden="true">✓</span>}
    </button>)}
  </div>;

  const trigger = <button
    ref={triggerRef}
    type="button"
    className={`${className}-trigger`}
    aria-label={label ? undefined : ariaLabel}
    aria-labelledby={label ? `${labelId} ${valueId}` : undefined}
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
    <span id={valueId} className={selectedIndex >= 0 ? '' : 'placeholder'}>{selectedLabel}</span>
    <span className={`${className}-chevron`} aria-hidden="true" />
  </button>;

  return <div ref={rootRef} className={`${className} ${inTable ? 'in-table' : ''} ${open ? 'open' : ''}`}>
    {name && <input type="hidden" name={name} value={selected} />}
    {label && <span id={labelId} className={`${className}-label`}>{label}</span>}
    {trigger}
    {menu && (portalMenu ? createPortal(menu, document.body) : menu)}
  </div>;
}
