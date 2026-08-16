import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { calendarMonthGrid, DateRangeCalendar } from './DateRangeCalendar';

describe('DateRangeCalendar', () => {
  it('uses the same fixed Monday-first 6 × 7 grid as the mobile calendar', () => {
    const cells = calendarMonthGrid(2026, 7);

    expect(cells).toHaveLength(42);
    expect(cells[5]).toEqual({ key: '2026-08-01', day: 1 });
    expect(cells[35]).toEqual({ key: '2026-08-31', day: 31 });
  });

  it('selects a start and then an end for a LabelScan period', () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <DateRangeCalendar
        label="Arrivage"
        from=""
        to=""
        onChange={onChange}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /du : à choisir/i }));
    fireEvent.click(screen.getByRole('button', { name: /lundi 10 août 2026/i }));
    expect(onChange).toHaveBeenLastCalledWith('2026-08-10', '');

    rerender(
      <DateRangeCalendar
        label="Arrivage"
        from="2026-08-10"
        to=""
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /jeudi 20 août 2026/i }));
    expect(onChange).toHaveBeenLastCalledWith('2026-08-10', '2026-08-20');
  });

  it('clears both ends of an existing period', () => {
    const onChange = vi.fn();
    render(
      <DateRangeCalendar
        label="Arrivage"
        from="2026-08-10"
        to="2026-08-20"
        onChange={onChange}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /10 août 2026/i }));
    fireEvent.click(screen.getByRole('button', { name: /effacer la période/i }));
    expect(onChange).toHaveBeenCalledWith('', '');
  });
});
