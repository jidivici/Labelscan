import {
  COMMON_COMMERCIAL_SECTION,
  COMMON_DATES_CONSERVATION_SECTION,
} from './shared';
import type { PortalDefinition } from './types';

export const boucheriePortal = {
  code: 'boucherie',
  label: 'Boucherie',
  shortLabel: 'Boucherie',
  description: 'Pilotage des lots de viande, de leur origine et des établissements agréés.',
  accent: '#087f72',
  initials: 'BO',
  featureFlag: 'portal.boucherie',
  detailSections: [
    {
      id: 'identification',
      title: 'Identification du produit',
      fields: [
        { key: 'commercial_designation', label: 'Désignation commerciale' },
        { key: 'animal_species', label: 'Espèce animale' },
        { key: 'animal_category', label: 'Catégorie' },
        { key: 'cut_name', label: 'Morceau / découpe' },
        { key: 'producer_name', label: 'Producteur' },
        { key: 'reseller_brand', label: 'Fournisseur / marque' },
      ],
    },
    {
      id: 'meat-origin',
      title: 'Origine et parcours de l’animal',
      fields: [
        { key: 'origin_country', label: 'Pays d’origine' },
        { key: 'birth_country', label: 'Pays de naissance' },
        { key: 'rearing_country', label: 'Pays d’élevage' },
        { key: 'slaughter_country', label: 'Pays d’abattage' },
        { key: 'cutting_country', label: 'Pays de découpe' },
      ],
    },
    {
      id: 'traceability',
      title: 'Traçabilité réglementaire',
      fields: [
        { key: 'batch_number', label: 'Numéro de lot' },
        { key: 'health_mark', label: 'Estampille sanitaire' },
        { key: 'slaughterhouse_approval', label: 'Agrément abattoir' },
        { key: 'cutting_plant_approval', label: 'Agrément atelier de découpe' },
        { key: 'gtin', label: 'Code-barres (GTIN)' },
      ],
    },
    COMMON_DATES_CONSERVATION_SECTION,
    COMMON_COMMERCIAL_SECTION,
  ],
  fieldFilters: [
    { field: 'animal_species', label: 'Espèce animale', type: 'text', placeholder: 'Ex. bovin, ovin' },
    { field: 'animal_category', label: 'Catégorie animale', type: 'text', placeholder: 'Ex. génisse, veau' },
    { field: 'cut_name', label: 'Morceau / découpe', type: 'text', placeholder: 'Ex. entrecôte, bavette' },
    { field: 'origin_country', label: 'Pays d’origine', type: 'text', placeholder: 'Ex. France' },
    { field: 'birth_country', label: 'Pays de naissance', type: 'text', placeholder: 'Ex. France' },
    { field: 'rearing_country', label: 'Pays d’élevage', type: 'text', placeholder: 'Ex. France' },
    { field: 'slaughter_country', label: 'Pays d’abattage', type: 'text', placeholder: 'Ex. France' },
    { field: 'cutting_country', label: 'Pays de découpe', type: 'text', placeholder: 'Ex. France' },
    { field: 'slaughterhouse_approval', label: 'Agrément abattoir', type: 'text', placeholder: 'Ex. FR 12.345.678 CE' },
    { field: 'cutting_plant_approval', label: 'Agrément atelier de découpe', type: 'text', placeholder: 'Ex. FR 12.345.679 CE' },
  ],
  secondaryColumns: [
    { key: 'expiry', label: 'Date limite de consommation', source: 'use_by', format: 'date' },
  ],
  labels: {
    pageTitle: 'Réceptions boucherie',
    pageDescription: 'Consultez les morceaux, les parcours d’origine et les agréments sanitaires de chaque lot.',
    searchPlaceholder: 'Morceau, lot, origine, agrément ou fournisseur…',
    emptyTitle: 'Aucun lot de viande à afficher',
    emptyDescription: 'Aucune réception boucherie ne correspond aux critères professionnels sélectionnés.',
    recordSingular: 'lot de viande',
    recordPlural: 'lots de viande',
  },
} satisfies PortalDefinition;
