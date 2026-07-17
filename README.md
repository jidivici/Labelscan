# LabelScan

Traçabilité HACCP des produits de la mer pour la poissonnerie de grande distribution.
L'opérateur photographie l'étiquette d'un arrivage ; l'application extrait, vérifie et
archive les **17 champs réglementaires** (dénomination, nom scientifique, zone FAO, lot,
DLC, estampille sanitaire, …) avec une doctrine stricte : **jamais de donnée fabriquée**,
tout est **auditable et immuable** côté serveur.

- **Mobile** : Expo / React Native (TypeScript) — capture enchaînée, revue éditable,
  enregistrement local, calendrier des arrivages.
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
- **Corrections auditables** : chaque correction humaine est POSTée au serveur en
  append-only (`source='human'`, jamais d'écrasement), avec outbox offline + clés
  d'idempotence.
- **Export** JSON / CSV des articles.

## Architecture (vue d'ensemble)

```text
Mobile (Expo RN)                        Backend (FastAPI + PostgreSQL)
┌─────────────────────────┐             ┌──────────────────────────────────────┐
│ Camera → scanQueue      │ POST /v1/   │ ingestion (append-only, idempotent)  │
│ (file persistante,      │ ingestions  │   └─ outbox transactionnel → worker  │
│  3 long-polls max)      ├────────────►│        OCR (Vision) → gate qualité   │
│ Review (17/17, brouillon│  GET status │        → interim regex → LLM (Haiku) │
│  overrides force_gs1)   │◄────────────┤        → gate no-fab → réconciliation│
│ Accueil (jour + heatmap)│  long-poll  │ contexts: ingestion/traceability/    │
│ AsyncStorage (articles) │             │  haccp/compliance/audit/identity     │
└─────────────────────────┘             └──────────────────────────────────────┘
```

Références détaillées : [`docs/architecture/ARCHITECTURE.md`](docs/architecture/ARCHITECTURE.md)
(+ ADR), [`docs/mobile/MOBILE-APP.md`](docs/mobile/MOBILE-APP.md),
[`docs/backend/API-CONTRACTS.md`](docs/backend/API-CONTRACTS.md),
[`docs/TECH-REVIEW.md`](docs/TECH-REVIEW.md) (revue de passation).

## Prérequis

- Node 20+, npm ; app **Expo dev client** (pas Expo Go : caméra + reanimated).
- Python 3.11+, Docker (PostgreSQL), PostgreSQL 16 en Homebrew pour les tests backend.
- Clés : `ANTHROPIC_API_KEY`, `LABELSCAN_GOOGLE_VISION_API_KEY` (serveur uniquement —
  **aucune clé** n'est embarquée dans le bundle mobile).

## Installation & lancement

```bash
# Backend (depuis la racine)
cp .env.example .env            # renseigner EXPO_PUBLIC_API_BASE_URL (IP LAN)
docker compose up               # db + api :8000 + 2 workers

# Mobile
npm install
npx expo start -c               # Metro ; app dev client sur le device
```

Connexion : identifiants admin définis côté serveur (`LABELSCAN_ADMIN_USERNAME` /
`LABELSCAN_ADMIN_PASSWORD`) ; l'app obtient un JWT via `POST /v1/auth/login`.

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
| `npm test` | Jest (22 suites, 212 tests) — logique pure uniquement, pas de rendu natif |
| `bash server/scripts/run_local_proofs.sh` | Suite backend complète : PG 16 **éphémère**, migrations, import-linter (5 contrats), pytest (242 tests) |
| `docker compose up` | Stack locale (db + api + 2 workers) |
| `npx expo run:ios` / `run:android` | Build dev client |

## Documentation

| Document | Contenu |
|---|---|
| [`docs/TECH-REVIEW.md`](docs/TECH-REVIEW.md) | **Revue technique de passation** (~1 h 30) : tout le projet, chaque choix justifié |
| [`docs/AUDIT-V1.1.md`](docs/AUDIT-V1.1.md) | Audit qualité v1.1 : forces, faiblesses, priorités, roadmap |
| [`docs/DEVELOPER-GUIDE.md`](docs/DEVELOPER-GUIDE.md) | Guide développeur : ajouter une fonctionnalité, conventions, git, déploiement |
| [`docs/mobile/MOBILE-APP.md`](docs/mobile/MOBILE-APP.md) | Référence vivante du front mobile |
| [`docs/backend/API-CONTRACTS.md`](docs/backend/API-CONTRACTS.md) + [`openapi.v1.yaml`](docs/backend/openapi.v1.yaml) | Contrats HTTP (problem+json, idempotence) |
| [`docs/database/DATABASE.md`](docs/database/DATABASE.md) | Schéma PostgreSQL, append-only, triggers |
| [`docs/ai-pipeline/AI-PIPELINE.md`](docs/ai-pipeline/AI-PIPELINE.md) + [`docs/extraction/PROMPT-CONTRACT.md`](docs/extraction/PROMPT-CONTRACT.md) | Pipeline OCR + LLM, gate anti-fabrication |
| [`docs/architecture/adr/`](docs/architecture/adr/) | Décisions d'architecture (7 ADR) |
| [`docs/PROD-READINESS.md`](docs/PROD-READINESS.md) / [`docs/IMPLEMENTATION-ROADMAP.md`](docs/IMPLEMENTATION-ROADMAP.md) | Chemin vers la prod / plan maître |
| `CLAUDE.md` | Journal de chantier et backlog vivants |

## État & limites connues

- Suite mobile et backend vertes (212 jest / 242 pytest) ; plusieurs éléments d'UI
  restent **à valider sur device** (checklists en fin de `CLAUDE.md`).
- Mono-utilisateur (un compte admin) — identité nominative/RBAC/SSO planifiés
  (`docs/IMPLEMENTATION-ROADMAP.md`, Phase 1).
- Stockage mobile AsyncStorage (port `ArticleStore` prêt pour SQLite à l'échelle).
- Voir l'audit v1.1 pour la liste priorisée complète.
