# LabelScan

De l'étiquette fournisseur à la fiche de traçabilité.

LabelScan réunit la capture mobile, l'extraction OCR/IA, la revue humaine et un catalogue partagé avec le back-office. Les profils Poissonnerie, Boucherie et Charcuterie / Traiteur organisent les informations selon le métier.

[Documentation technique illustrée](docs/TECHNICAL-DOCUMENTATION-FR.md) · [PDF, 24 pages](output/pdf/LabelScan_Documentation_Technique.pdf) · [Schémas Excalidraw](docs/diagrams/labelscan.excalidraw)

![Architecture LabelScan](docs/diagrams/01-composants.svg)

## Le parcours

1. Photographier l'étiquette et joindre le code-barres détecté.
2. Suivre l'extraction et consulter les propositions.
3. Renseigner les champs et confirmer la revue.
4. Retrouver l'arrivage et sa photographie dans le catalogue.

## La plateforme

| Composant | Technologie du dépôt |
|---|---|
| Mobile | Expo 57, React Native 0.86, React 19.2 |
| Back-office | React 19, Vite |
| API et workers | Python, FastAPI |
| Données | PostgreSQL 16, stockage d'images privé |
| Extraction | Google Vision, Anthropic Claude |

Le [sommaire documentaire](docs/README.md) donne accès aux chapitres et au contrat OpenAPI.

## Licence

[MIT](LICENSE) · © 2026 Brice Fontaine.
