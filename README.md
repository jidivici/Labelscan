# LabelScan

### De l'étiquette fournisseur à la fiche de traçabilité.

LabelScan accompagne la réception de produits alimentaires : une application mobile capture l'étiquette, le serveur en extrait les informations et l'opérateur confirme la fiche. Le catalogue et le back-office donnent ensuite accès aux arrivages, à leurs données et à leur photographie.

**Poissonnerie · Boucherie · Charcuterie / Traiteur**

[Découvrir le produit](docs/TECHNICAL-DOCUMENTATION-FR.md#produit) · [Démarrer en local](#démarrage-local) · [Guide du dépôt](docs/GUIDE-DU-DEPOT.md) · [Documentation PDF](output/pdf/LabelScan_Documentation_Technique.pdf)

---

## Un parcours, de la capture au catalogue

| Capturer | Structurer | Confirmer et retrouver |
|---|---|---|
| Photographier l'étiquette et joindre le code-barres détecté. | Lire le texte par OCR, produire des champs structurés et conserver leur provenance. | Revoir les propositions, enregistrer les valeurs humaines et consulter l'arrivage. |

La capture et la revue sont distinctes : le traitement continue en arrière-plan pendant que l'opérateur poursuit ses prises de vue. Trois profils adaptent les champs au métier. Le mobile sert le travail sur le terrain ; le web permet la recherche, la consultation et l'administration.

## Architecture en un regard

![Architecture : clients mobile et web, API FastAPI, worker, PostgreSQL, stockage privé et fournisseurs OCR/IA](docs/diagrams/01-composants.png)

L'API reçoit les opérations. Les workers exécutent les traitements longs. Une **outbox PostgreSQL**, table d'événements à traiter, relie la capture, l'extraction et la publication du catalogue. Les photographies sont conservées dans un stockage d'objets, séparé des données métier.

[Les quatre schémas commentés](docs/README.md#schémas-visibles-sur-github) · [Source Excalidraw éditable](docs/diagrams/labelscan.excalidraw) · [Modèle de données](docs/TECHNICAL-DOCUMENTATION-FR.md#modele)

## Démarrage local

Prérequis : **Git, Docker avec Compose v2 et Node.js 22.13+ dans la branche 22**. La pile Docker construit aussi le back-office. Le développement Python hors conteneur demande Python 3.12 ; le runner de tests local utilise les binaires PostgreSQL 16.

### 1. Préparer la démonstration

```bash
git clone https://github.com/jidivici/Labelscan.git
cd Labelscan
cp server/.env.example server/.env
cp server/demo/credentials.example.json server/demo/credentials.local.json
```

Dans ces deux fichiers locaux, renseigner les mots de passe de démonstration, les paramètres PostgreSQL, le secret JWT et les clés des fournisseurs utilisés pour les nouvelles extractions. La [fiche de démarrage](server/demo/README.md#configuration) détaille les valeurs attendues. Les neuf arrivages préchargés proviennent des photos du dépôt.

### 2. Lancer la plateforme

```bash
docker compose --env-file server/.env up --build -d --wait
docker compose --env-file server/.env ps
curl --fail http://localhost:8000/v1/health/ready
```

Ouvrir **http://localhost:8000/backoffice/** et se connecter avec un compte du fichier local. Compose initialise la base, applique les migrations, charge la démonstration puis démarre l'API et les workers.

### 3. Connecter le mobile

```bash
npm ci
cp .env.example .env
```

Renseigner `EXPO_PUBLIC_API_BASE_URL` avec l'adresse de l'API accessible depuis le téléphone, puis suivre le [démarrage Android ou iOS](docs/GUIDE-DU-DEPOT.md#interfaces). Sur un téléphone physique, cette adresse est l'IP réseau de l'ordinateur, pas `localhost`.

## Se repérer dans le dépôt

| Emplacement | Responsabilité | Point d'entrée |
|---|---|---|
| `src/` | Application mobile, écrans et services | [Navigation](src/navigation/RootNavigator.tsx) |
| `web/` | Back-office React, portails et administration | [Routes](web/src/router/AppRouter.tsx) |
| `server/` | API, métier, workers, migrations et tests | [Guide serveur](server/README.md) |
| `deploy/` | Topologies Docker, proxy et livraison VPS | [Guide de déploiement](deploy/README.md) |
| `scripts/`, `.github/` | Vérifications, génération et intégration continue | [Qualité et tests](docs/GUIDE-DU-DEPOT.md#qualite) |
| `docs/`, `output/pdf/` | Guide, synthèse technique, UML et contrat HTTP | [Sommaire illustré](docs/README.md) |

### Technologies

| Mobile | Web | Serveur | Données et extraction |
|---|---|---|---|
| Expo 57, React Native 0.86, TypeScript | React 19, Vite 7, TypeScript | Python, FastAPI, SQLAlchemy, Alembic | PostgreSQL 16, stockage privé, Google Vision, Anthropic Claude |

## Vérifier le projet

```bash
# À la racine : typage et tests du mobile
npm run typecheck
npm test -- --runInBand

# Back-office : installation, tests et build
npm --prefix web ci
npm --prefix web test
npm --prefix web run build
```

Les [tests serveur](server/README.md#tests) utilisent PostgreSQL. Les [parcours navigateur](docs/GUIDE-DU-DEPOT.md#qualite) couvrent trois tailles d'écran. Les workflows versionnés automatisent les contrôles sur leurs périmètres respectifs.

## Une documentation à plusieurs niveaux

- **Comprendre le produit** : [parcours, profils et interfaces](docs/TECHNICAL-DOCUMENTATION-FR.md#parcours).
- **Prendre le code en main** : [guide pédagogique, de l'environnement aux tests](docs/GUIDE-DU-DEPOT.md).
- **Lire la conception** : [architecture, UML, données et API](docs/TECHNICAL-DOCUMENTATION-FR.md#architecture).
- **Présenter les réalisations** : [repères RNCP niveau 5 et preuves dans le code](docs/GUIDE-DU-DEPOT.md#rncp).
- **Intégrer l'API** : [contrat OpenAPI](docs/backend/openapi.v1.yaml).

## Licence

[MIT](LICENSE) · © 2026 Brice Fontaine.
