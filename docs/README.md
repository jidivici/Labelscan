# Documentation LabelScan

Comprendre le produit, démarrer le projet et retrouver les preuves dans le code. Deux documents complémentaires constituent le cœur de la documentation ; une édition PDF les réunit.

## Choisir son parcours

| Besoin | Document |
|---|---|
| Découvrir les usages, les métiers et les échanges | [Documentation technique illustrée](TECHNICAL-DOCUMENTATION-FR.md) |
| Installer, lire le code, tester et comprendre la livraison | [Guide pédagogique du dépôt](GUIDE-DU-DEPOT.md) |
| Présenter les réalisations sous l'angle RNCP niveau 5 | [Compétences et preuves techniques](GUIDE-DU-DEPOT.md#rncp) |
| Lire hors ligne ou imprimer | [Édition PDF complète, 34 pages](../output/pdf/LabelScan_Documentation_Technique.pdf) |
| Consulter les routes et les schémas HTTP | [Contrat OpenAPI](backend/openapi.v1.yaml) |

Les entrées spécialisées restent courtes : [serveur](../server/README.md), [démonstration locale](../server/demo/README.md), [déploiement](../deploy/README.md).

## Les 15 fichiers de la livraison documentaire

L'ensemble comprend **7 Markdown, 4 PNG, 1 fichier Excalidraw, 1 contrat OpenAPI, 1 PDF et 1 générateur**. Les chemins ci-dessous sont relatifs à la racine du dépôt.

### Lecture · 7 Markdown

- [README.md](../README.md) — Présentation et démarrage local.
- [docs/README.md](README.md) — Parcours de lecture et inventaire des livrables.
- [docs/TECHNICAL-DOCUMENTATION-FR.md](TECHNICAL-DOCUMENTATION-FR.md) — Produit, architecture, données et API.
- [docs/GUIDE-DU-DEPOT.md](GUIDE-DU-DEPOT.md) — Environnement, lecture du code, tests et repères RNCP niveau 5.
- [server/README.md](../server/README.md) — Développement et tests du serveur.
- [server/demo/README.md](../server/demo/README.md) — Configuration et lancement de la démonstration.
- [deploy/README.md](../deploy/README.md) — Topologies et déroulement de la livraison.

### Visuels · 4 PNG et la source Excalidraw

- [docs/diagrams/01-composants.png](diagrams/01-composants.png) — Composants et échanges.
- [docs/diagrams/02-sequence.png](diagrams/02-sequence.png) — Capture, extraction, revue et publication.
- [docs/diagrams/03-etats.png](diagrams/03-etats.png) — États de l'ingestion.
- [docs/diagrams/04-modele.png](diagrams/04-modele.png) — Modèle de données.
- [docs/diagrams/labelscan.excalidraw](diagrams/labelscan.excalidraw) — Les quatre illustrations réunies sur une planche éditable.

### Contrat · OpenAPI

- [docs/backend/openapi.v1.yaml](backend/openapi.v1.yaml) — Routes, paramètres et schémas HTTP.

### Génération · PDF et script

- [output/pdf/LabelScan_Documentation_Technique.pdf](../output/pdf/LabelScan_Documentation_Technique.pdf) — Édition complète de 34 pages.
- [scripts/build_documentation.py](../scripts/build_documentation.py) — Génération du PDF et des formats graphiques.

## Repères visuels

La palette sémantique retenue pour le PDF associe **vert aux usages**, **bleu à l'architecture**, **violet aux données**, **ambre à l'API** et **ardoise à la plateforme**. Les titres nomment également chaque thème.

Les README conservent le style natif de GitHub : titres, liens, listes, tableaux et aperçus PNG. Le README d'accueil présente le parcours fonctionnel dans un petit diagramme Mermaid ; les quatre illustrations détaillées restent disponibles ci-dessous et dans Excalidraw.

## Schémas visibles sur GitHub

Les aperçus PNG ci-dessous s'affichent directement dans GitHub. Cliquer sur une image permet de l'ouvrir en grand. Les mêmes définitions graphiques produisent le PDF vectoriel et la [planche Excalidraw éditable](diagrams/labelscan.excalidraw).

### 1. Composants : qui communique avec qui ?

Le mobile et le web utilisent l'API. Le worker prend en charge les événements et appelle les fournisseurs d'extraction. La base et le stockage d'images ont des responsabilités distinctes.

![Vue UML des composants LabelScan](diagrams/01-composants.png)

[Lire l'architecture](TECHNICAL-DOCUMENTATION-FR.md#architecture)

### 2. Séquence : quand la capture devient-elle une fiche ?

L'acceptation HTTP, l'extraction et la revue sont trois temps séparés. La publication catalogue suit l'enregistrement de la revue humaine.

![Séquence UML de la capture, de l'extraction et de la revue](diagrams/02-sequence.png)

[Lire la séquence](TECHNICAL-DOCUMENTATION-FR.md#sequence)

### 3. États : comment lire l'avancement ?

L'état d'ingestion décrit l'étape technique. La confirmation humaine distingue une proposition extraite d'une fiche revue.

![Principaux états UML de l'ingestion](diagrams/03-etats.png)

[Lire les transitions et leurs variantes](TECHNICAL-DOCUMENTATION-FR.md#etats)

### 4. Données : comment conserver la provenance ?

Le modèle relie le magasin, le portail, la capture, ses artefacts et les versions de ses champs. La légende distingue les clés étrangères des liens par identifiant.

![Modèle UML des principales données de capture et d'extraction](diagrams/04-modele.png)

[Lire le modèle relationnel](TECHNICAL-DOCUMENTATION-FR.md#modele)

## Éditer les schémas

Télécharger [labelscan.excalidraw](diagrams/labelscan.excalidraw) avec le bouton de téléchargement du fichier, puis l'ouvrir dans Excalidraw. Ce fichier conserve les formes et textes modifiables ; les PNG sont les aperçus de lecture.

## Régénérer la documentation

Le [générateur](../scripts/build_documentation.py) utilise les deux Markdown comme sources éditoriales et des définitions de schémas communes aux trois formats. Il vérifie les débordements de page et le plafond de 50 pages.

Prérequis : Python 3.11+, ReportLab, les polices DejaVu Sans et Poppler (`pdftoppm`). Depuis un environnement Python activé, à la racine :

```bash
python -m pip install reportlab
python scripts/build_documentation.py
```

`LABELSCAN_DOC_FONT_DIR` permet de fournir le répertoire des polices et `LABELSCAN_DOC_PDFTOPPM` le chemin du convertisseur. Les sauts de page `<!-- page -->` organisent le PDF sans gêner la lecture GitHub.

### Constituer le dossier complet

```bash
python scripts/build_documentation.py --package
```

Cette commande produit aussi `output/LabelScan_Documentation_Proposition.zip`, une archive des 15 fichiers listés ci-dessus. Elle conserve les chemins du dépôt : documents de lecture, sources éditables, aperçus et outil de génération. Elle n'embarque ni le code applicatif, déjà présent dans le dépôt, ni les fichiers locaux de configuration.
