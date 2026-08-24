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

export function DetailSections({ sections, fields }: {
  sections: readonly PortalDetailSection[];
  fields: Record<string, string | null>;
}) {
  const visibleSections = sections
    .map((section) => ({ ...section, fields: section.fields.filter((field) => Boolean(fields[field.key]?.trim())) }))
    .filter((section) => section.fields.length > 0);

  if (visibleSections.length === 0) return null;

  return <div className="detail-sections">{visibleSections.map((section) => <section className="detail-section" key={section.id}>
    <h4>{section.title}</h4>
    <dl>{section.fields.map((field) => <div key={field.key}><dt>{field.label}</dt><dd><span>{fieldValue(fields[field.key], field.format)}</span></dd></div>)}</dl>
  </section>)}</div>;
}
