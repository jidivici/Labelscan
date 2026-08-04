import { COMMON_IDENTIFICATION_SECTION } from './shared';
import type { PortalDefinition } from './types';

export const charcuterieTraiteurPortal = {
  code: 'charcuterie_traiteur',
  label: 'Charcuterie–Traiteur',
  shortLabel: 'Charcuterie–Traiteur',
  description: 'Pilotage unifié des produits de charcuterie et des préparations traiteur.',
  accent: '#9a611f',
  initials: 'CT',
  featureFlag: 'portal.charcuterie-traiteur',
  detailSections: [
    COMMON_IDENTIFICATION_SECTION,
    {
      id: 'prepared-product',
      title: 'Famille et fabrication',
      fields: [
        { key: 'product_family', label: 'Famille : charcuterie ou traiteur' },
        { key: 'manufacturer_name', label: 'Fabricant' },
        { key: 'preparation_date', label: 'Date de préparation', format: 'date' },
      ],
    },
    {
      id: 'prepared-composition',
      title: 'Composition, allergènes et utilisation',
      fields: [
        { key: 'ingredients', label: 'Ingrédients' },
        { key: 'additives', label: 'Additifs' },
        { key: 'allergens', label: 'Allergènes' },
        { key: 'use_instructions', label: 'Conseils d’utilisation' },
        { key: 'reheating_instructions', label: 'Instructions de réchauffage' },
      ],
    },
    {
      id: 'prepared-conservation',
      title: 'Conditionnement et conservation',
      fields: [
        { key: 'conditioning_type', label: 'Conditionnement' },
        { key: 'storage_mode', label: 'Chaîne de conservation' },
        { key: 'storage_temperature', label: 'Température de conservation', format: 'temperature' },
        { key: 'packaging_date', label: 'Date de conditionnement', format: 'date' },
        { key: 'expiry_date', label: 'DLC / DDM', format: 'date' },
      ],
    },
    {
      id: 'prepared-traceability',
      title: 'Traçabilité sanitaire',
      fields: [
        { key: 'batch_number', label: 'Numéro de lot' },
        { key: 'origin_country', label: 'Pays d’origine' },
        { key: 'health_mark', label: 'Estampille sanitaire' },
      ],
    },
    {
      id: 'prepared-commercial',
      title: 'Données commerciales',
      fields: [
        { key: 'weight', label: 'Poids' },
        { key: 'price', label: 'Prix' },
      ],
    },
  ],
  fieldFilters: [
    {
      field: 'product_family',
      label: 'Famille de produit',
      type: 'select',
      options: [
        { value: 'charcuterie', label: 'Charcuterie' },
        { value: 'traiteur', label: 'Traiteur' },
      ],
    },
    { field: 'manufacturer_name', label: 'Fabricant', type: 'text', placeholder: 'Nom du fabricant' },
    { field: 'allergens', label: 'Allergènes', type: 'text', placeholder: 'Ex. lait, œufs, moutarde' },
    { field: 'conditioning_type', label: 'Conditionnement', type: 'text', placeholder: 'Ex. sous vide, barquette' },
    { field: 'preparation_date', label: 'Date de préparation', type: 'text', placeholder: 'AAAA-MM-JJ' },
    { field: 'storage_temperature', label: 'Température', type: 'text', placeholder: 'Ex. 0 à 4 °C' },
    {
      field: 'storage_mode',
      label: 'Chaîne de conservation',
      type: 'select',
      options: [
        { value: 'chaîne froide', label: 'Chaîne froide' },
        { value: 'chaîne chaude', label: 'Chaîne chaude' },
      ],
    },
    { field: 'ingredients', label: 'Ingrédients', type: 'text', placeholder: 'Rechercher un ingrédient' },
    { field: 'additives', label: 'Additifs', type: 'text', placeholder: 'Ex. E250, nitrite' },
  ],
  secondaryColumns: [
    { key: 'packaging-date', label: 'Conditionné le', source: 'packaging_date', format: 'date' },
    { key: 'expiry', label: 'DLC / DDM', source: 'use_by', format: 'date' },
    { key: 'completeness', label: 'Complétude', source: 'completeness', format: 'percentage' },
    { key: 'alert', label: 'Alerte', source: 'alert_state', format: 'alert' },
  ],
  kpis: [
    { key: 'total', label: 'Réceptions', metric: 'total', description: 'Produits du périmètre filtré', tone: 'neutral' },
    { key: 'expiry', label: 'DLC à surveiller', metric: 'flagged', description: 'Lots signalés pour échéance ou contrôle', tone: 'warning' },
    { key: 'alerts', label: 'Alertes ouvertes', metric: 'openAlerts', description: 'Alertes non acquittées', tone: 'danger' },
    { key: 'incomplete', label: 'Fiches incomplètes', metric: 'incomplete', description: 'Traçabilité à compléter', tone: 'warning' },
  ],
  labels: {
    pageTitle: 'Réceptions Charcuterie–Traiteur',
    pageDescription: 'Contrôlez dans un même portail les familles, compositions, DLC et chaînes de conservation.',
    searchPlaceholder: 'Produit, famille, lot, fabricant ou fournisseur…',
    emptyTitle: 'Aucune réception Charcuterie–Traiteur',
    emptyDescription: 'Aucun produit transformé ou préparé ne correspond aux critères professionnels sélectionnés.',
    recordSingular: 'produit transformé ou préparé',
    recordPlural: 'produits transformés ou préparés',
  },
} satisfies PortalDefinition;
