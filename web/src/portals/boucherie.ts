import { COMMON_CONSERVATION_SECTION, COMMON_IDENTIFICATION_SECTION, COMMON_TRACEABILITY_SECTION } from './shared';
import type { PortalDefinition } from './types';

export const boucheriePortal = {
  code: 'boucherie',
  label: 'Boucherie',
  shortLabel: 'Boucherie',
  description: 'Pilotage des lots de viande, de leur origine et des établissements agréés.',
  accent: '#a13e4d',
  initials: 'BO',
  featureFlag: 'portal.boucherie',
  detailSections: [
    COMMON_IDENTIFICATION_SECTION,
    {
      id: 'meat-identification',
      title: 'Animal et découpe',
      fields: [
        { key: 'animal_species', label: 'Espèce animale' },
        { key: 'animal_category', label: 'Catégorie' },
        { key: 'cut_name', label: 'Morceau / découpe' },
      ],
    },
    {
      id: 'meat-origin',
      title: 'Élevage, abattage et transformation',
      fields: [
        { key: 'birth_country', label: 'Pays de naissance' },
        { key: 'rearing_country', label: 'Pays d’élevage' },
        { key: 'slaughter_country', label: 'Pays d’abattage' },
        { key: 'cutting_country', label: 'Pays de découpe' },
        { key: 'slaughterhouse_approval', label: 'Agrément abattoir' },
        { key: 'cutting_plant_approval', label: 'Agrément atelier de découpe' },
      ],
    },
    COMMON_TRACEABILITY_SECTION,
    COMMON_CONSERVATION_SECTION,
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
    { key: 'completeness', label: 'Complétude traçabilité', source: 'completeness', format: 'percentage' },
    { key: 'alert', label: 'Alerte sanitaire', source: 'alert_state', format: 'alert' },
  ],
  kpis: [
    { key: 'total', label: 'Lots de viande', metric: 'total', description: 'Réceptions dans le périmètre filtré', tone: 'neutral' },
    { key: 'flagged', label: 'Lots à contrôler', metric: 'flagged', description: 'Contrôles prioritaires à effectuer', tone: 'warning' },
    { key: 'alerts', label: 'Alertes sanitaires', metric: 'openAlerts', description: 'Alertes ouvertes non acquittées', tone: 'danger' },
    { key: 'incomplete', label: 'Traçabilités incomplètes', metric: 'incomplete', description: 'Origine ou informations réglementaires à compléter', tone: 'warning' },
  ],
  labels: {
    pageTitle: 'Réceptions boucherie',
    pageDescription: 'Contrôlez les morceaux, les parcours d’origine et les agréments sanitaires de chaque lot.',
    searchPlaceholder: 'Morceau, lot, origine, agrément ou fournisseur…',
    emptyTitle: 'Aucun lot de viande à afficher',
    emptyDescription: 'Aucune réception boucherie ne correspond aux critères professionnels sélectionnés.',
    recordSingular: 'lot de viande',
    recordPlural: 'lots de viande',
  },
} satisfies PortalDefinition;
