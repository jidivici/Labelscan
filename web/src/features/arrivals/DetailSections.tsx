import type { PortalDetailSection } from '../../portals/types';

function dateValue(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}/.test(value)) return value;
  const parsed = new Date(`${value.slice(0, 10)}T00:00:00`);
  return Number.isNaN(parsed.getTime()) ? value : new Intl.DateTimeFormat('fr-FR', { dateStyle: 'long' }).format(parsed);
}

function fieldValue(value: string | null | undefined, format: PortalDetailSection['fields'][number]['format']): string {
  if (!value?.trim()) return '';
  if (format === 'date') return dateValue(value);
  if (format === 'production_method') {
    if (value === 'wild_caught') return 'Pêche sauvage';
    if (value === 'farmed') return 'Élevage';
  }
  return value;
}

function validationLabel(value: string | undefined): string {
  const labels: Record<string, string> = {
    accepted: 'Validé',
    valid: 'Validé',
    warning: 'À vérifier',
    invalid: 'Non valide',
    missing: 'Manquant',
  };
  return value ? labels[value] ?? value.replaceAll('_', ' ') : '';
}

export function DetailSections({ sections, fields, validation = {} }: {
  sections: readonly PortalDetailSection[];
  fields: Record<string, string | null>;
  validation?: Record<string, { source?: string; validation_status?: string }>;
}) {
  const visibleSections = sections
    .map((section) => ({ ...section, fields: section.fields.filter((field) => Boolean(fields[field.key]?.trim())) }))
    .filter((section) => section.fields.length > 0);

  if (visibleSections.length === 0) return null;

  return <div className="detail-sections">{visibleSections.map((section) => <section className="detail-section" key={section.id}>
    <h4>{section.title}</h4>
    <dl>{section.fields.map((field) => {
      const evidence = validation[field.key];
      const metadata = [evidence?.source, validationLabel(evidence?.validation_status)].filter(Boolean).join(' · ');
      return <div key={field.key}><dt>{field.label}</dt><dd><span>{fieldValue(fields[field.key], field.format)}</span>{metadata && <small>{metadata}</small>}</dd></div>;
    })}</dl>
  </section>)}</div>;
}
