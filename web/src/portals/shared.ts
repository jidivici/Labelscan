import type { PortalDetailSection, PortalKpiDefinition } from './types';

export const COMMON_IDENTIFICATION_SECTION: PortalDetailSection = {
  id: 'identification',
  title: 'Identification du produit',
  fields: [
    { key: 'commercial_designation', label: 'Désignation commerciale' },
    { key: 'producer_name', label: 'Producteur' },
    { key: 'reseller_brand', label: 'Fournisseur / marque' },
    { key: 'gtin', label: 'GTIN' },
  ],
};

export const COMMON_TRACEABILITY_SECTION: PortalDetailSection = {
  id: 'traceability',
  title: 'Traçabilité réglementaire',
  fields: [
    { key: 'batch_number', label: 'Numéro de lot' },
    { key: 'origin_country', label: 'Pays d’origine' },
    { key: 'health_mark', label: 'Estampille sanitaire' },
    { key: 'packaging_date', label: 'Date de conditionnement', format: 'date' },
    { key: 'expiry_date', label: 'Date limite', format: 'date' },
  ],
};

export const COMMON_CONSERVATION_SECTION: PortalDetailSection = {
  id: 'conservation',
  title: 'Conservation et données commerciales',
  fields: [
    { key: 'storage_temperature', label: 'Température', format: 'temperature' },
    { key: 'allergens', label: 'Allergènes' },
    { key: 'weight', label: 'Poids' },
    { key: 'price', label: 'Prix' },
  ],
};

export const STANDARD_KPIS: readonly PortalKpiDefinition[] = [
  { key: 'total', label: 'Arrivages', metric: 'total', description: 'Dans le périmètre filtré', tone: 'neutral' },
  { key: 'flagged', label: 'Signalés', metric: 'flagged', description: 'À traiter en priorité', tone: 'warning' },
  { key: 'alerts', label: 'Alertes ouvertes', metric: 'openAlerts', description: 'Non acquittées', tone: 'danger' },
  { key: 'incomplete', label: 'Incomplets', metric: 'incomplete', description: 'Complétude inférieure à 100 %', tone: 'warning' },
];
