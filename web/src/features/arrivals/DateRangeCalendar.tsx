import { useEffect, useMemo, useRef, useState } from 'react';

const WEEKDAYS = ['L', 'M', 'M', 'J', 'V', 'S', 'D'] as const;

interface CalendarCell {
  key: string;
  day: number;
}

interface DateRangeCalendarProps {
  label: string;
  from: string;
  to: string;
  disableFuture?: boolean;
  onChange: (from: string, to: string) => void;
}

function dayKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

function monthOfKey(key: string): { year: number; month: number } {
  const parsed = /^(\d{4})-(\d{2})-\d{2}$/.exec(key);
  const fallback = new Date();
  return parsed
    ? { year: Number(parsed[1]), month: Number(parsed[2]) - 1 }
    : { year: fallback.getFullYear(), month: fallback.getMonth() };
}

function addMonths(year: number, month: number, delta: number): { year: number; month: number } {
  const date = new Date(year, month + delta, 1);
  return { year: date.getFullYear(), month: date.getMonth() };
}

export function calendarMonthGrid(year: number, month: number): (CalendarCell | null)[] {
  const mondayOffset = (new Date(year, month, 1).getDay() + 6) % 7;
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const monthPart = String(month + 1).padStart(2, '0');
  return Array.from({ length: 42 }, (_, index) => {
    const day = index - mondayOffset + 1;
    return day < 1 || day > daysInMonth
      ? null
      : { key: `${year}-${monthPart}-${String(day).padStart(2, '0')}`, day };
  });
}

function formatDate(key: string, fallback: string): string {
  const parsed = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!parsed) return fallback;
  return new Date(Number(parsed[1]), Number(parsed[2]) - 1, Number(parsed[3])).toLocaleDateString('fr-FR', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

function formatLongDate(key: string): string {
  const parsed = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!parsed) return key;
  return new Date(Number(parsed[1]), Number(parsed[2]) - 1, Number(parsed[3])).toLocaleDateString('fr-FR', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

export function DateRangeCalendar({
  label,
  from,
  to,
  disableFuture = false,
  onChange,
}: DateRangeCalendarProps) {
  const [activeBoundary, setActiveBoundary] = useState<'from' | 'to' | null>(null);
  const open = activeBoundary !== null;
  const [displayed, setDisplayed] = useState(() => monthOfKey(from || to));
  const rootRef = useRef<HTMLDivElement>(null);
  const today = dayKey(new Date());
  const currentMonth = monthOfKey(today);
  const cells = useMemo(
    () => calendarMonthGrid(displayed.year, displayed.month),
    [displayed.month, displayed.year],
  );
  const title = new Date(displayed.year, displayed.month, 1).toLocaleDateString('fr-FR', {
    month: 'long',
    year: 'numeric',
  });
  const canGoNext = !disableFuture
    || displayed.year < currentMonth.year
    || (displayed.year === currentMonth.year && displayed.month < currentMonth.month);

  useEffect(() => {
    if (activeBoundary) setDisplayed(monthOfKey(activeBoundary === 'from' ? from : to || from));
  }, [activeBoundary, from, to]);

  useEffect(() => {
    if (!open) return undefined;
    const closeOnOutsidePress = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setActiveBoundary(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setActiveBoundary(null);
    };
    document.addEventListener('pointerdown', closeOnOutsidePress);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePress);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);

  function selectDay(key: string) {
    if (activeBoundary === 'from') onChange(key, to && to >= key ? to : '');
    else if (!from) onChange(key, key);
    else onChange(key < from ? key : from, key < from ? from : key);
    setActiveBoundary(null);
  }

  return <div className={`date-range-filter ${open ? 'open' : ''}`} ref={rootRef}>
    <span className="date-range-label">{label}</span>
    <div className="date-range-fields">
      <button type="button" className={`date-range-box ${activeBoundary === 'from' ? 'active' : ''}`} onClick={() => setActiveBoundary((value) => value === 'from' ? null : 'from')} aria-label={`Date de début : ${formatDate(from, 'Choisir')}`} aria-expanded={activeBoundary === 'from'} aria-haspopup="dialog">
        <small>DÉBUT</small><strong>{formatDate(from, 'Choisir')}</strong>
      </button>
      <span aria-hidden="true">→</span>
      <button type="button" className={`date-range-box ${activeBoundary === 'to' ? 'active' : ''}`} onClick={() => setActiveBoundary((value) => value === 'to' ? null : 'to')} aria-label={`Date de fin : ${formatDate(to, 'Choisir')}`} aria-expanded={activeBoundary === 'to'} aria-haspopup="dialog">
        <small>FIN</small><strong>{formatDate(to, 'Choisir')}</strong>
      </button>
    </div>

    {open && <div className="labelscan-calendar" role="dialog" aria-label={`Période — ${label}`}>
      <header className="labelscan-calendar-brand">
        <span>LABELSCAN · ARRIVAGES</span>
        <strong>{label} du / au</strong>
        <small>{activeBoundary === 'from' ? 'Sélectionnez la date de début.' : 'Sélectionnez la date de fin.'}</small>
      </header>

      <div className="labelscan-calendar-selection" aria-live="polite">
        <span><small>DU</small><strong>{formatDate(from, 'À choisir')}</strong></span>
        <span aria-hidden="true">→</span>
        <span><small>AU</small><strong>{formatDate(to, 'À choisir')}</strong></span>
      </div>

      <div className="labelscan-calendar-navigation">
        <button type="button" onClick={() => setDisplayed(addMonths(displayed.year, displayed.month, -1))} aria-label="Mois précédent">‹</button>
        <strong>{title.charAt(0).toUpperCase() + title.slice(1)}</strong>
        <button type="button" disabled={!canGoNext} onClick={() => setDisplayed(addMonths(displayed.year, displayed.month, 1))} aria-label="Mois suivant">›</button>
      </div>

      <div className="labelscan-calendar-grid" role="grid">
        {WEEKDAYS.map((weekday, index) => <span className="labelscan-calendar-weekday" key={`${weekday}-${index}`} role="columnheader">{weekday}</span>)}
        {cells.map((cell, index) => {
          if (!cell) return <span className="labelscan-calendar-empty" key={`empty-${index}`} />;
          const isFuture = disableFuture && cell.key > today;
          const isStart = cell.key === from;
          const isEnd = cell.key === to;
          const isInRange = Boolean(from && to && cell.key > from && cell.key < to);
          return <button
            type="button"
            className={[
              'labelscan-calendar-day',
              cell.key === today ? 'today' : '',
              isInRange ? 'in-range' : '',
              isStart || isEnd ? 'selected' : '',
            ].filter(Boolean).join(' ')}
            disabled={isFuture}
            onClick={() => selectDay(cell.key)}
            aria-label={formatLongDate(cell.key)}
            aria-pressed={isStart || isEnd}
            key={cell.key}
          >{cell.day}</button>;
        })}
      </div>

      <footer className="labelscan-calendar-footer">
        <button type="button" className="calendar-today-button" onClick={() => { setDisplayed(currentMonth); selectDay(today); }}>Aujourd’hui</button>
        <button type="button" className="calendar-clear-button" disabled={!from && !to} onClick={() => { onChange('', ''); setActiveBoundary(null); }}>Effacer la période</button>
      </footer>
    </div>}
  </div>;
}
