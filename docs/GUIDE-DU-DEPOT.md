# Guide du dépôt LabelScan

Du premier lancement à la lecture du code : dix repères pour comprendre comment l'application est construite et vérifiée.

[Organisation](#organisation) · [Environnement](#environnement) · [Interfaces](#interfaces) · [Serveur](#serveur) · [Parcours du code](#parcours-code) · [Données et API](#donnees-api) · [Tests](#qualite) · [Livraison](#livraison) · [RNCP 5](#rncp) · [Lexique](#lexique)

Ce guide complète la [documentation technique](TECHNICAL-DOCUMENTATION-FR.md). Les liens conduisent aux implémentations ; le [PDF commun](../output/pdf/LabelScan_Documentation_Technique.pdf) réunit les deux lectures.

<!-- page -->
<a id="organisation"></a>
## G01 · Organisation du dépôt

LabelScan est un dépôt commun à trois applications : le mobile, le back-office et le serveur. Chaque application conserve ses dépendances et ses tests. Les documents relient ces composants par un parcours fonctionnel partagé.

```text
Labelscan/
  App.tsx, src/       Application mobile React Native
  android/, ios/     Projets natifs generes localement par Expo
  web/               Back-office React et tests navigateur
  server/
    src/labelscan/   API, cas d'usage et traitements
    migrations/     Evolutions du schema PostgreSQL
    tests/, demo/   Verification et donnees de demonstration
  deploy/            Compose, proxy et scripts de livraison
  scripts/           Controles transverses et generation PDF
  .github/           Integration continue et automatisation
  docs/              Guides, UML et contrat OpenAPI
  output/pdf/        Edition paginee
```

### Trois points d'entrée

| Application | Premier fichier à lire | Ce qu'il assemble |
|---|---|---|
| Mobile | [RootNavigator.tsx](../src/navigation/RootNavigator.tsx) | Liste, caméra, revue et détail produit |
| Web | [AppRouter.tsx](../web/src/router/AppRouter.tsx) | Connexion, portails, arrivages et espaces administratifs |
| Serveur | [http_app.py](../server/src/labelscan/app/http_app.py) | Routes, middlewares et fichiers du back-office |

Les profils métier ont un contrat canonique côté [serveur](../server/src/labelscan/business_profiles.py). Les clients en présentent les libellés et regroupements adaptés à leur interface.

Les répertoires [assets](../assets/) et [vendor](../vendor/) contiennent respectivement les ressources de l'application et une dépendance locale. Les fichiers `package-lock.json` et les verrous Python fixent les dépendances résolues.

<!-- page -->
<a id="environnement"></a>
## G02 · Environnement local

Le démarrage commun utilise Docker Compose : PostgreSQL, les migrations, le jeu de démonstration, l'API et les workers sont décrits dans [docker-compose.yml](../docker-compose.yml). Le back-office est compilé dans l'image serveur.

### Préparer puis démarrer

Depuis un clone neuf, copier les modèles puis renseigner leurs valeurs locales selon la [fiche de configuration](../server/demo/README.md#configuration).

```bash
cp server/.env.example server/.env
cp server/demo/credentials.example.json \
  server/demo/credentials.local.json
docker compose --env-file server/.env up --build -d --wait
```

L'option `--env-file server/.env` fournit à Compose les variables utilisées dans le YAML. Le même fichier est chargé comme environnement des processus serveur. Le démarrage respecte les dépendances : base disponible, migrations terminées, démonstration chargée, puis services applicatifs.

| Adresse locale | Usage |
|---|---|
| `http://localhost:8000/backoffice/` | Interface web intégrée |
| `http://localhost:8000/docs` | Exploration interactive de l'API en développement |
| `http://localhost:8000/v1/health/live` | Présence du processus API |
| `http://localhost:8000/v1/health/ready` | Accès à PostgreSQL et au stockage d'objets |

### Observer et arrêter

```bash
docker compose --env-file server/.env ps
docker compose --env-file server/.env logs --tail=50 server worker
docker compose --env-file server/.env stop
```

`stop` arrête les conteneurs sans supprimer les volumes. Après cet arrêt, `docker compose --env-file server/.env start db server worker` reprend les services existants sans rejouer le chargement de démonstration. Les arrivages préchargés permettent de parcourir le catalogue ; une nouvelle capture traverse le traitement OCR/IA configuré.

<!-- page -->
<a id="interfaces"></a>
## G03 · Développer les interfaces

### Application mobile

Node.js 22.13+ dans la branche 22 et les dépendances installées par `npm ci` constituent l'environnement JavaScript. Copier `.env.example` dans `.env`, puis renseigner `EXPO_PUBLIC_API_BASE_URL` avec l'URL joignable depuis l'appareil.

Avec Android Studio, le SDK et un appareil ou émulateur configurés :

```bash
LABELSCAN_BUILD_PROFILE=development npm run android
```

Sur macOS, avec Xcode et son simulateur configurés :

```bash
npm run ios
```

Ces commandes construisent et lancent le client natif de développement. Pour une session suivante avec ce client installé :

```bash
LABELSCAN_BUILD_PROFILE=development npx expo start --dev-client
```

Le profil `development` active la configuration Android destinée à l'API locale HTTP. Les réglages natifs sont regroupés dans [app.config.js](../app.config.js). L'application cible uniquement Android 16 ou une version ultérieure (API 36 minimum) ; cette règle est vérifiée par `npm run check:android16` avant chaque livraison.

### Back-office web

```bash
npm --prefix web ci
npm --prefix web run build
```

Le résultat est `web/dist`. L'API peut servir ce répertoire avec `LABELSCAN_STATIC_DIR` ; le [guide serveur](../server/README.md#exécution-hors-docker) donne la commande. Le client web utilise des URL `/v1/...` de même origine. Le serveur Vite seul sert le travail d'interface, sans proxy API configuré dans le dépôt.

Les [constantes graphiques mobile](../src/theme/) centralisent couleurs, typographie et espacement. Le [style web](../web/src/styles.css) définit les adaptations d'écran et le focus visible. Les composants de sélection gèrent la navigation clavier, couverte par des tests ciblés.

<!-- page -->
<a id="serveur"></a>
## G04 · Lire le serveur par couches

Le serveur est un **monolithe modulaire** : un même projet Python contient plusieurs domaines métier. L'API et les workers sont des processus distincts qui réutilisent ses composants.

| Couche | Rôle | Exemple dans l'ingestion |
|---|---|---|
| `domain` | Types et règles métier | Normalisation et contrôle des champs |
| `application` | Enchaînement d'un cas d'usage | [finalize_review.py](../server/src/labelscan/contexts/ingestion/application/finalize_review.py) |
| `adapters` | Entrées HTTP et implémentations techniques | Routes, repositories SQL, OCR et IA |
| `app` | Assemblage des composants | Fabrique FastAPI et lancement du worker |
| `platform` | Services partagés | Base, stockage, HTTP et observabilité |

Un **port** est une interface attendue par un cas d'usage. Un **adaptateur** fournit son implémentation. La finalisation d'une revue dépend ainsi d'un repository, et non d'une requête SQL écrite directement dans la route HTTP.

### Domaines actifs

- `identity` : sessions, organisations, magasins, utilisateurs et accès.
- `ingestion` : captures, extraction, champs et revue humaine.
- `traceability` : lots et projection de consultation du catalogue.
- `haccp` : règles d'alerte et cycle de traitement des alertes.

Le [contrat d'import](../server/.importlinter) formalise les dépendances autorisées entre couches et domaines. `lint-imports` contrôle ces frontières ; les tests exercent les règles et les adaptateurs.

Le [guide serveur](../server/README.md) regroupe les commandes d'installation, d'exécution et de test. La [vue des modules](TECHNICAL-DOCUMENTATION-FR.md#modules) complète cette lecture structurelle.

<!-- page -->
<a id="parcours-code"></a>
## G05 · Suivre une fonctionnalité

La confirmation d'une fiche est un parcours vertical : une action d'interface traverse HTTP, un cas d'usage, une transaction et un traitement asynchrone.

| Étape | Responsabilité | Source à lire |
|---|---|---|
| 1. Saisie | Vérifier puis conserver la revue dans l'outbox mobile | [ReviewScreen.tsx](../src/screens/ReviewScreen.tsx) |
| 2. Transport | Envoyer l'opération conservée à la route `/reviews` | [api.ts](../src/services/api.ts) |
| 3. Entrée HTTP | Recevoir et convertir le corps de la requête | [router.py](../server/src/labelscan/contexts/ingestion/adapters/http/router.py) |
| 4. Cas d'usage | Contrôler le jeu de champs et les valeurs finales | [finalize_review.py](../server/src/labelscan/contexts/ingestion/application/finalize_review.py) |
| 5. Persistance | Résoudre le profil enregistré et écrire la revue avec son événement | [sql_review_repository.py](../server/src/labelscan/contexts/ingestion/adapters/sql_review_repository.py) |
| 6. Publication | Consommer l'événement puis alimenter le catalogue | [Adaptateurs de traçabilité](../server/src/labelscan/contexts/traceability/adapters/) |

### Ce que le découpage explique

Le contrôle mobile aide l'opérateur pendant la saisie. Le contrôle serveur applique le contrat métier reçu par l'API. La transaction regroupe les écritures de la revue ; la publication intervient ensuite, via l'événement `review.finalized`.

L'**idempotence** reconnaît la répétition d'une même opération. Elle est distincte de la validation : une requête peut être correctement formée tout en répétant un travail déjà enregistré.

Le [diagramme de séquence](TECHNICAL-DOCUMENTATION-FR.md#sequence) montre ces temps successifs. Le [test de finalisation](../server/tests/test_finalize_review.py) vérifie notamment la répétition sans doublon et la publication catalogue. Le [chapitre revue](TECHNICAL-DOCUMENTATION-FR.md#revue) décrit la complétude et les décisions `NC` permises.

<!-- page -->
<a id="donnees-api"></a>
## G06 · Données et contrat HTTP

### De la preuve à la consultation

Une ingestion identifie la capture. Ses artefacts désignent les fichiers conservés. Les runs regroupent les résultats successifs d'extraction ou de revue ; leurs champs portent les valeurs et leur provenance. Le catalogue est une projection de lecture destinée aux interfaces.

| Élément | Rôle dans le modèle |
|---|---|
| Organisation, magasin, portail | Situer les utilisateurs et les données dans leur contexte métier |
| Ingestion et artefacts | Relier la capture, son état et ses fichiers |
| Run et champs extraits | Conserver les versions, valeurs, sources et évidences |
| Lot et projection catalogue | Alimenter la consultation d'un arrivage |

Le [modèle UML](TECHNICAL-DOCUMENTATION-FR.md#modele) distingue les relations SQL déclarées des associations par identifiant. Les [migrations Alembic](../server/migrations/) décrivent l'évolution du schéma. Les colonnes JSONB stockent des valeurs structurées **dans PostgreSQL**, au sein du modèle relationnel.

### Lire une route

| Opération | Échange principal |
|---|---|
| `POST /v1/ingestions` | Photo multipart et contexte ; réponse `202` avec identifiant |
| `GET /v1/ingestions/{id}` | État de la capture et informations d'extraction |
| `POST /v1/ingestions/{id}/reviews` | Revue complète selon le profil enregistré |
| `GET /v1/arrivals` | Consultation filtrée et paginée du catalogue |
| `GET /v1/arrivals/export` | Export serveur JSON ou CSV |

Le [contrat OpenAPI](backend/openapi.v1.yaml) décrit les paramètres et structures exacts. Les [chapitres API](TECHNICAL-DOCUMENTATION-FR.md#api) donnent une lecture par usage. Une réponse `202` signifie que la capture a été acceptée, pas que l'extraction est déjà terminée.

<!-- page -->
<a id="qualite"></a>
## G07 · Vérifier à plusieurs niveaux

Les tests associent règles isolées, composants d'interface, accès aux données et parcours navigateur. Chaque niveau répond à une question différente.

| Niveau | Exemples du dépôt | Outil |
|---|---|---|
| Règles mobile | Dates, GS1, complétude et gestion des opérations | Jest |
| Interface web | Profils, filtres, accès et panneaux de détail | Vitest et Testing Library |
| Parcours navigateur | Navigation, clavier et adaptation aux écrans | Playwright, API simulée |
| Métier et persistance | Revue, idempotence, transactions et projections | pytest avec PostgreSQL |
| Architecture | Frontières d'import et contrat HTTP à jour | import-linter et export OpenAPI |

### Commandes clients, depuis la racine

```bash
npm run typecheck
npm test -- --runInBand
npm --prefix web run typecheck
npm --prefix web test
npm --prefix web run build
```

### Parcours navigateur, depuis web/

Après `npm ci`, installer Chromium puis lancer les scénarios :

```bash
npx playwright install chromium
npm run test:e2e
```

La configuration construit le web, ouvre son aperçu et exécute les scénarios aux formats 1440 × 900, 1024 × 768 et 390 × 844. Les tests [portal-access](../web/e2e/portal-access.spec.ts) couvrent notamment les accès, le clavier et le débordement horizontal.

Les [instructions serveur](../server/README.md#tests) utilisent une base dédiée aux tests. Les workflows [clients](../.github/workflows/client-ci.yml) et [backend](../.github/workflows/backend-ci.yml) versionnent l'ordre des contrôles et leurs environnements.

<!-- page -->
<a id="livraison"></a>
## G08 · De la source à l'exécution

Le [Dockerfile serveur](../server/Dockerfile) réalise une construction en plusieurs étapes : compilation du web, installation des dépendances Python verrouillées, puis assemblage de l'image d'exécution. Le serveur livre ainsi l'API et les fichiers statiques du back-office.

| Processus | Commande du point d'entrée | Fonction |
|---|---|---|
| Migrations | `migrate` | Appliquer les évolutions Alembic |
| API | `api` | Exposer HTTP et servir le back-office |
| Worker | `worker` | Traiter les événements et les extractions |
| Démonstration locale | `demo` | Charger le jeu d'arrivages photographiques |

### Construction locale de l'image

Depuis la racine du dépôt :

```bash
docker build -f server/Dockerfile -t labelscan:local .
```

Cette commande construit l'artefact ; elle ne crée pas une base et ne déploie pas de service. Compose fournit ensuite la topologie, les paramètres et les volumes de l'environnement d'exécution.

### Configurations versionnées

Le profil **single-VPS** regroupe proxy, base, API et worker. Le profil **managed** référence PostgreSQL externe et un stockage compatible S3. Le [guide de déploiement](../deploy/README.md) identifie les fichiers, les paramètres et le déroulement du workflow VPS.

La chaîne de livraison distingue validation du code et mise en production. Les workflows de CI exécutent leurs contrôles ; le workflow de livraison sélectionne une révision et lance le script distant. La version, la disponibilité HTTP et la préparation des dépendances sont exposées par les endpoints d'exploitation.

Les [chapitres plateforme et observabilité](TECHNICAL-DOCUMENTATION-FR.md#plateforme) expliquent le rôle des services, journaux et compteurs dans cette exécution.

<!-- page -->
<a id="rncp"></a>
## G09 · Repères RNCP niveau 5

Le repère de lecture retenu est le titre **Développeur web et web mobile**, RNCP37674, niveau 5. Le référentiel distingue la réalisation des interfaces et celle des traitements serveur. Source : [fiche officielle France compétences](https://www.francecompetences.fr/recherche/rncp/37674/).

La correspondance décrit les réalisations présentées par ce dépôt. Elle relie une explication technique à des éléments observables dans le projet.

| Axe de lecture | Réalisation LabelScan | Preuve à présenter |
|---|---|---|
| Environnement | Dépendances, services et configuration locale | [Démarrage](GUIDE-DU-DEPOT.md#environnement), verrous et Compose |
| Conception d'interface | Parcours opérateur, hiérarchie des écrans et profils | [Parcours fonctionnel](TECHNICAL-DOCUMENTATION-FR.md#parcours), navigation et constantes graphiques |
| Interface et adaptation | Composants React, styles responsive et clavier | [Styles web](../web/src/styles.css), [tests navigateur](../web/e2e/portal-access.spec.ts) |
| Interface dynamique | Session, formulaires, appels API et suivi d'extraction | [Revue mobile](../src/screens/ReviewScreen.tsx), [client web](../web/src/api.ts) |
| Persistance relationnelle | Modèle, migrations, SQL paramétré et transactions | [Modèle UML](TECHNICAL-DOCUMENTATION-FR.md#modele), [repository](../server/src/labelscan/contexts/ingestion/adapters/sql_ingestion_repository.py) |
| Traitements métier | Validation, provenance et publication asynchrone | [Parcours vertical](GUIDE-DU-DEPOT.md#parcours-code), [test de revue](../server/tests/test_finalize_review.py) |
| Livraison | Image, services et workflow versionné | [Déploiement](../deploy/README.md), Dockerfile et CI |

### Fil conducteur d'une présentation

Partir du besoin de réception, suivre une capture jusqu'à sa fiche, puis expliquer une décision de conception à partir du code : séparation API/worker, transaction de revue ou adaptation des champs au métier. Terminer par les tests qui vérifient ce comportement et par les éléments qui composent la livraison.

Ce parcours relie **besoin, interface, traitement, données et vérification**, sans séparer la démonstration produit de son explication technique.

<!-- page -->
<a id="lexique"></a>
## G10 · Lexique et conventions

| Terme | Sens dans LabelScan |
|---|---|
| Ingestion | Capture reçue par le serveur, identifiée et suivie par un état |
| Artefact | Fichier conservé et rattaché à une capture, par exemple une photographie |
| OCR | Lecture du texte contenu dans l'image |
| Extraction | Transformation des indices disponibles en champs du profil métier |
| Run | Version d'un résultat d'extraction ou d'une revue humaine |
| Évidence | Extrait de texte associé à une proposition de champ |
| Profil métier | Ensemble versionné de champs et règles pour une profession |
| Portail | Contexte de travail associant magasin et métier |
| Revue | Intervention humaine qui renseigne et confirme les valeurs de la fiche |
| `NC` | Valeur non renseignée ; décision humaine ou règle d'affichage selon le contexte |
| Outbox | File d'opérations mobile ou table d'événements serveur à traiter |
| Idempotence | Reconnaissance de la répétition d'une même opération |
| Projection | Vue de lecture construite à partir des données et événements métier |
| Arrivage | Fiche consultable d'un lot issu d'une capture revue |

### Vocabulaire technique

**Repository** : composant d'accès aux données. **Middleware** : traitement qui entoure le passage d'une requête HTTP.

**CI** : intégration continue, qui exécute automatiquement les contrôles du projet. **JWT** : format de jeton signé utilisé pour la session.

**UML** : notation de modélisation des structures et échanges. **GS1** : standards d'identification et de codage des informations produit.
