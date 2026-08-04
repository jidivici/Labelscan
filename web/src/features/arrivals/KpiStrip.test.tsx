import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { STANDARD_KPIS } from '../../portals/shared';
import type { ArrivalMetrics } from '../../types';
import { KpiStrip, resolveKpiValue } from './KpiStrip';

const metrics: ArrivalMetrics = { total: 128, flagged: 7, openAlerts: 3, incomplete: 11 };

describe('KpiStrip', () => {
  it('resolves configured metrics without portal-specific branching', () => {
    expect(resolveKpiValue(STANDARD_KPIS[1], metrics)).toBe(7);
    expect(resolveKpiValue(STANDARD_KPIS[3], metrics)).toBe(11);
  });

  it('renders server-provided KPI values', () => {
    render(<KpiStrip definitions={STANDARD_KPIS} metrics={metrics} loading={false} />);

    expect(screen.getByText('128')).toBeInTheDocument();
    expect(screen.getByText('7')).toBeInTheDocument();
    expect(screen.getByText('Alertes ouvertes')).toBeInTheDocument();
    expect(screen.getByText('11')).toBeInTheDocument();
  });

  it('does not invent values while metrics are loading', () => {
    render(<KpiStrip definitions={STANDARD_KPIS} metrics={null} loading />);
    expect(screen.getAllByText('—')).toHaveLength(STANDARD_KPIS.length);
  });
});
