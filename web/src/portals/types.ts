import type { Arrival, ProfessionCode } from '../types';

export interface PortalSelectOption {
  value: string;
  label: string;
}

export interface PortalFieldFilterDefinition {
  field: string;
  label: string;
  type: 'text' | 'select';
  placeholder?: string;
  options?: readonly PortalSelectOption[];
}

export interface PortalDetailField {
  key: string;
  label: string;
  format?: 'text' | 'date' | 'temperature' | 'production_method';
}

export interface PortalDetailSection {
  id: string;
  title: string;
  fields: readonly PortalDetailField[];
}

export interface PortalSecondaryColumn {
  key: string;
  label: string;
  source: keyof Arrival;
  format?: 'text' | 'date';
}

export interface PortalLabels {
  pageTitle: string;
  pageDescription: string;
  searchPlaceholder: string;
  emptyTitle: string;
  emptyDescription: string;
  recordSingular: string;
  recordPlural: string;
}

export interface PortalDefinition {
  code: ProfessionCode;
  label: string;
  shortLabel: string;
  description: string;
  accent: string;
  initials: string;
  featureFlag: string;
  detailSections: readonly PortalDetailSection[];
  fieldFilters: readonly PortalFieldFilterDefinition[];
  secondaryColumns: readonly PortalSecondaryColumn[];
  labels: PortalLabels;
}
