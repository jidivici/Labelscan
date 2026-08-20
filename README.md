# LabelScan

Traçabilité HACCP des produits de la mer pour la poissonnerie de grande distribution.
L'opérateur photographie l'étiquette d'un arrivage ; l'application extrait, vérifie et
archive les **17 champs réglementaires** (dénomination, nom scientifique, zone FAO, lot,
DLC, estampille sanitaire, …) avec une doctrine stricte : **jamais de donnée fabriquée**,
tout est **auditable et immuable** côté serveur.

- **Mobile** : Expo / React Native (TypeScript) — capture enchaînée, revue éditable,
  synchronisation automatique et catalogue serveur avec cache hors ligne.
- **Backoffice web** : portail React partagé, catalogue photographique pour les
  opérateurs et gestion des comptes et magasins pour les admins.
- **Backend** : FastAPI / PostgreSQL (Python 3.11) — monolithe modulaire hexagonal,
  pipeline hybride GS1 + OCR (Google Vision) + LLM (Claude Haiku, escalade Opus),
  append-only + audit.

---

## Fonctionnalités

- **Capture enchaînée** : l'envoi part dès le déclencheur (soumission spéculative), on
  enchaîne les photos ; chaque scan vit dans une file persistante visible sur l'accueil
  (« En cours », étapes Photo envoyée → Extraction → À valider / À compléter).
- **Extraction hybride en 3 vagues** : GS1-128 décodé sur l'appareil (T+0, lot/DLC/GTIN/
  poids exacts), aperçu déterministe regex dès la fin de l'OCR (~2 s), puis LLM. Le
  code-barres **gagne toujours** sur l'OCR pour les champs qu'il porte.
- **Revue 17/17** : tous les champs éditables (y compris GS1, sous flag d'audit
  `force_gs1`), brouillon persistant, autocomplétion depuis l'historique validé,
  enregistrement possible uniquement à 17/17.
- **Calendrier des arrivages** (v1.1) : accueil organisé par journée ; vue mensuelle
  style « GitHub Contributions » (intensité = volume), sélection d'un jour = la liste
  bascule instantanément, recherche omnisciente qui reste globale.
- **Validation atomique 17/17** : la révision humaine complète et la confirmation
  sont enregistrées ensemble, en append-only, avec rejeu idempotent.
- **Multi-organisation** : JWT tenanté, magasins, RLS PostgreSQL et photos privées
  isolent chaque groupe.

## Architecture (vue d'ensemble)

```text
Mobile (Expo RN)                        Backend (FastAPI + PostgreSQL)
┌─────────────────────────┐             ┌──────────────────────────────────────┐
│ Camera → scanQueue      │ POST /v1/   │ ingestion (append-only, idempotent)  │
│ (file persistante,      │ ingestions  │   └─ outbox transactionnel → worker  │
│  3 long-polls max)      ├────────────►│        OCR (Vision) → gate qualité   │
│ Review (17/17, brouillon│  GET status │        → interim regex → LLM (Haiku) │
│  overrides force_gs1)   │◄────────────┤        → gate no-fab → réconciliation│
│ Catalogue API + cache   │  long-poll  │ contexts: ingestion/traceability/    │
│ Outbox finalize_review  │             │ haccp/audit/identity + projection    │
└─────────────────────────┘             └──────────────────────────────────────┘
```

Références détaillées : [`docs/README.md`](docs/README.md),
[`docs/ENTERPRISE-ARCHITECTURE.md`](docs/ENTERPRISE-ARCHITECTURE.md),
[`docs/architecture/adr/`](docs/architecture/adr/), [`docs/mobile/MOBILE-APP.md`](docs/mobile/MOBILE-APP.md),
[`docs/backend/API-CONTRACTS.md`](docs/backend/API-CONTRACTS.md),
et [`docs/security/SECURITY-ARCHITECTURE.md`](docs/security/SECURITY-ARCHITECTURE.md).

## Prérequis

- Node 20+, npm ; app **Expo dev client** (pas Expo Go : caméra + reanimated).
- Python 3.11+, Docker (PostgreSQL), PostgreSQL 16 en Homebrew pour les tests backend.
- Clés : `ANTHROPIC_API_KEY`, `LABELSCAN_GOOGLE_VISION_API_KEY` (serveur uniquement —
  **aucune clé** n'est embarquée dans le bundle mobile).

## Installation & lancement

```bash
# Backend (depuis la racine)
cp .env.example .env            # renseigner EXPO_PUBLIC_API_BASE_URL (IP LAN)
cp server/demo/credentials.example.json server/demo/credentials.local.json
# remplacer les six valeurs du fichier local par des phrases de passe uniques
docker compose up               # db + api :8000 + 2 workers

# Mobile
npm install
npx expo start -c               # Metro ; app dev client sur le device
```

Le démarrage local utilise la base dédiée `labelscan_demo` et installe
automatiquement une démonstration idempotente :
4 magasins nommés par ville, 1 super-administrateur, 1 administrateur,
4 managers et 9 arrivages construits à partir de vraies photos d'étiquettes,
normalisées pour être lues dans le bon sens.
Les anciennes projections issues des tests ne sont pas affichées.

Les six identifiants sont `super_admin`, `admin`, `manager_p_f`, `manager_p_n`,
`manager_p_c` et `manager_p_m`. Leurs mots de passe ne sont pas publiés : ils viennent
uniquement du fichier local ignoré `server/demo/credentials.local.json`.

Convention manager : `p` = poissonnerie ; `f`, `n`, `c` et `m` = Fréjus,
Nice, Cannes et Marseille.

En production, les éventuels comptes de démonstration reçoivent des secrets uniques
root-only et toutes leurs anciennes sessions sont révoquées, sans resemer ni supprimer
les images et arrivages existants.

Connexion mobile : compte manager créé par l’administrateur dans le portail ;
l’app obtient un JWT via `POST /v1/mobile/auth/login`. Un compte administrateur
est volontairement refusé sur l’application mobile.

Portail web utilisateurs, magasins et arrivages :
[http://localhost:8000/backoffice/o/labelscan/](http://localhost:8000/backoffice/o/labelscan/).
Les administrateurs gèrent les comptes et magasins ; les managers
accèdent aux arrivages enregistrés pour leur magasin, avec recherche et filtres
par date. Ces arrivages sont persistés dans PostgreSQL et partagés entre les
comptes autorisés du magasin.

Pour initialiser ou réinitialiser le compte administrateur défini dans `server/.env` :

```bash
docker compose up -d --build
docker compose exec server python -m labelscan.contexts.identity.adapters.cli
```

Ouvrir ensuite `/backoffice/o/labelscan/`, saisir `LABELSCAN_ADMIN_USERNAME` et
`LABELSCAN_ADMIN_PASSWORD`, créer d'abord les établissements avec
**Magasins**, puis utiliser les écrans de gestion des accès pour créer les autres
comptes administrateur ou manager.

## Variables d'environnement

| Où | Variable | Rôle |
|---|---|---|
| Mobile (`.env`) | `EXPO_PUBLIC_API_BASE_URL` | Base URL du backend (IP LAN pour un device). **Inlinée au build** — redémarrer Metro après changement. |
| Serveur (`server/.env`) | `DATABASE_URL` | PostgreSQL (`postgresql+psycopg://…`) |
| | `ANTHROPIC_API_KEY` | LLM d'extraction (Claude) |
| | `LABELSCAN_GOOGLE_VISION_API_KEY` | OCR Google Vision |
| | `LABELSCAN_JWT_SECRET`, `LABELSCAN_JWT_TTL_SECONDS` | Auth JWT |
| | `LABELSCAN_ADMIN_USERNAME`, `LABELSCAN_ADMIN_PASSWORD` | Compte opérateur |
| | `LABELSCAN_LLM_MODEL`, `LABELSCAN_LLM_ESCALATION_*` | Modèle Haiku + escalade Opus |
| | `LABELSCAN_OCR_*` | Provider, feature, gate qualité OCR |
| | `LABELSCAN_RAW_STORE_DIR`, `LABELSCAN_OUTBOX_MAX_RETRIES`, `LABELSCAN_LOG_LEVEL`, … | Voir `server/README.md` |

Les `.env` sont git-ignorés et vérifiés absents de tout l'historique.

## Commandes

| Commande | Effet |
|---|---|
| `npm run typecheck` | TypeScript strict, 0 erreur attendu |
| `npm test` | Suite Jest mobile |
| `npm run check:android8` | Vérifie le plancher API 26 et les garde-fous réseau de la release Android |
| `npm run security:production -- https://label-scan.fr` | Refuse une cible publique qui n'applique pas les garde-fous de production |
| `bash server/scripts/run_local_proofs.sh` | PostgreSQL éphémère, migrations, contrats d’architecture et tests backend |
| `docker compose up` | Stack locale (db + api + 2 workers) |
| `npx expo run:ios` / `run:android` | Build dev client |

## Documentation

| Document | Contenu |
|---|---|
| [`docs/README.md`](docs/README.md) | Index des références vivantes et règle d’archivage |
| [`docs/DEVELOPER-GUIDE.md`](docs/DEVELOPER-GUIDE.md) | Guide développeur : ajouter une fonctionnalité, conventions, git, déploiement |
| [`docs/mobile/MOBILE-APP.md`](docs/mobile/MOBILE-APP.md) | Référence vivante du front mobile |
| [`docs/backend/API-CONTRACTS.md`](docs/backend/API-CONTRACTS.md) + [`openapi.v1.yaml`](docs/backend/openapi.v1.yaml) | Contrats HTTP (problem+json, idempotence) |
| [`docs/database/DATABASE.md`](docs/database/DATABASE.md) | Schéma PostgreSQL, append-only, triggers |
| [`docs/ai-pipeline/AI-PIPELINE.md`](docs/ai-pipeline/AI-PIPELINE.md) + [`docs/extraction/PROMPT-CONTRACT.md`](docs/extraction/PROMPT-CONTRACT.md) | Pipeline OCR + LLM, gate anti-fabrication |
| [`docs/architecture/adr/`](docs/architecture/adr/) | Décisions d'architecture |
| [`docs/security/`](docs/security/) | Architecture, modèle de menace et validation production |
| [`docs/archive/`](docs/archive/) | Audits, plans et présentations historiques |

## État & limites connues

- Suites mobile, portail et backend vertes ; builds React et Android validés.
- Comptes nominatifs, RBAC `super_admin`/`admin`/`manager`, organisations, magasins, RLS et
  stockage S3 compatible sont implémentés. SSO/OIDC reste hors de ce chantier.
- Le téléphone conserve une file hors ligne et un cache ; PostgreSQL et le
  stockage objet restent les sources de vérité.
- Les limites de production sont suivies dans `docs/security/` et les contrôles automatisés.
