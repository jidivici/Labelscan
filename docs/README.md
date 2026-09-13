# Documentation LabelScan

Une documentation technique illustrée présente le produit et son fonctionnement.

| Format | Contenu |
|---|---|
| [Synthèse technique](TECHNICAL-DOCUMENTATION-FR.md) | Parcours, profils, architecture, données, API et plateforme |
| [PDF](../output/pdf/LabelScan_Documentation_Technique.pdf) | Édition mise en page, 24 pages |
| [Excalidraw](diagrams/labelscan.excalidraw) | Quatre schémas UML éditables |
| [OpenAPI](backend/openapi.v1.yaml) | Inventaire HTTP généré depuis le serveur |

## Les quatre vues UML

- [Composants](diagrams/01-composants.svg)
- [Séquence de capture et revue](diagrams/02-sequence.svg)
- [États d'ingestion](diagrams/03-etats.svg)
- [Modèle de données](diagrams/04-modele.svg)

Les SVG et le PDF proviennent des mêmes définitions graphiques. Le générateur est [scripts/build_documentation.py](../scripts/build_documentation.py) ; sa dépendance de rendu est ReportLab, avec les polices DejaVu Sans.

Construction depuis la racine : `python scripts/build_documentation.py`.
