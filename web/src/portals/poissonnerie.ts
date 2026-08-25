import {
  COMMON_COMMERCIAL_SECTION,
  COMMON_DATES_CONSERVATION_SECTION,
  COMMON_TRACEABILITY_SECTION,
} from './shared';
import type { PortalDefinition } from './types';

export const poissonneriePortal = {
  code: 'poissonnerie',
  label: 'Poissonnerie',
  shortLabel: 'Poissonnerie',
  description: 'Traçabilité des produits de la mer et des arrivages.',
  accent: '#087f73',
  initials: 'PO',
  featureFlag: 'portal.poissonnerie',
  detailSections: [
    {
      id: 'identification',
      title: 'Identification du produit',
      fields: [
        { key: 'commercial_designation', label: 'Désignation commerciale' },
        { key: 'scientific_name', label: 'Nom scientifique' },
        { key: 'producer_name', label: 'Producteur' },
        { key: 'reseller_brand', label: 'Fournisseur / marque' },
      ],
    },
    {
      id: 'fishing-origin',
      title: 'Provenance et production',
      fields: [
        { key: 'origin_country', label: 'Pays d’origine' },
        { key: 'FAO_area', label: 'Zone FAO' },
        { key: 'production_method', label: 'Mode de production', format: 'production_method' },
        { key: 'fishing_gear_or_farming_method', label: 'Engin de pêche / élevage' },
      ],
    },
    COMMON_TRACEABILITY_SECTION,
    COMMON_DATES_CONSERVATION_SECTION,
    COMMON_COMMERCIAL_SECTION,
    {
      id: 'historical-data',
      title: 'Informations historiques',
      fields: [
        { key: 'product_name', label: 'Désignation historique' },
        { key: 'supplier_name', label: 'Fournisseur historique' },
      ],
    },
  ],
  fieldFilters: [
    {
      field: 'commercial_designation',
      label: 'Espèce / désignation commerciale',
      type: 'text',
      placeholder: 'Ex. saumon atlantique',
    },
    { field: 'scientific_name', label: 'Nom scientifique', type: 'text', placeholder: 'Ex. Salmo salar' },
    { field: 'FAO_area', label: 'Zone FAO', type: 'text', placeholder: 'Ex. 27' },
    {
      field: 'production_method',
      label: 'Mode de production',
      type: 'select',
      options: [
        { value: 'wild_caught', label: 'Pêche sauvage' },
        { value: 'farmed', label: 'Élevage' },
      ],
    },
    {
      field: 'fishing_gear_or_farming_method',
      label: 'Engin de pêche / méthode d’élevage',
      type: 'text',
      placeholder: 'Ex. chalut, ligne ou bassin',
    },
  ],
  secondaryColumns: [
    { key: 'scientific-name', label: 'Nom scientifique', source: 'scientific_name' },
    { key: 'fao-area', label: 'Zone FAO', source: 'fao_area_code' },
    { key: 'use-by', label: 'À consommer avant', source: 'use_by', format: 'date' },
  ],
  labels: {
    pageTitle: 'Tableau de bord poissonnerie',
    pageDescription: 'Pilotez les arrivages, les origines de pêche et la conformité de la traçabilité.',
    searchPlaceholder: 'Désignation, nom scientifique, zone FAO, lot ou fournisseur…',
    emptyTitle: 'Aucun arrivage de produits de la mer',
    emptyDescription: 'Aucun arrivage ne correspond au périmètre et aux filtres actifs.',
    recordSingular: 'arrivage',
    recordPlural: 'arrivages',
  },
} satisfies PortalDefinition;
