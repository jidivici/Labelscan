import type { PortalKpiDefinition } from '../../portals/types';
import type { ArrivalMetrics } from '../../types';

export function resolveKpiValue(definition: PortalKpiDefinition, metrics: ArrivalMetrics): number {
  return metrics[definition.metric];
}

export function KpiStrip({ definitions, metrics, loading }: { definitions: readonly PortalKpiDefinition[]; metrics: ArrivalMetrics | null; loading: boolean }) {
  return <section className="kpi-strip" aria-label="Indicateurs du portail">{definitions.map((definition) =>
    <article className={`kpi-card ${definition.tone}`} key={definition.key}>
      <span className="kpi-label">{definition.label}</span>
      <strong>{loading || !metrics ? '—' : resolveKpiValue(definition, metrics).toLocaleString('fr-FR')}</strong>
      <small>{definition.description}</small>
    </article>,
  )}</section>;
}
