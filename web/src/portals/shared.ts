import type { PortalDetailSection } from './types';

export const COMMON_IDENTIFICATION_SECTION: PortalDetailSection = {
  id: 'identification',
  title: 'Identification du produit',
  fields: [
    { key: 'commercial_designation', label: 'Désignation commerciale' },
    { key: 'producer_name', label: 'Producteur' },
    { key: 'reseller_brand', label: 'Fournisseur / marque' },
  ],
};

export const COMMON_TRACEABILITY_SECTION: PortalDetailSection = {
  id: 'traceability',
  title: 'Traçabilité réglementaire',
  fields: [
    { key: 'batch_number', label: 'Numéro de lot' },
    { key: 'health_mark', label: 'Estampille sanitaire' },
    { key: 'gtin', label: 'Code-barres (GTIN)' },
  ],
};

export const COMMON_DATES_CONSERVATION_SECTION: PortalDetailSection = {
  id: 'dates-conservation',
  title: 'Dates et conservation',
  fields: [
    { key: 'packaging_date', label: 'Date de conditionnement', format: 'date' },
    { key: 'expiry_date', label: 'Date limite', format: 'date' },
    { key: 'storage_temperature', label: 'Température', format: 'temperature' },
    { key: 'allergens', label: 'Allergènes' },
  ],
};

export const COMMON_COMMERCIAL_SECTION: PortalDetailSection = {
  id: 'commercial',
  title: 'Données commerciales',
  fields: [
    { key: 'weight', label: 'Poids' },
  ],
};
