# LabelScan — Revue technique de passation

**Format :** lecture/présentation ~1 h 30, pensée pour un passage de relais. Un nouveau
développeur doit pouvoir, après cette revue, situer n'importe quel fichier du dépôt et
comprendre *pourquoi* il est là.
**Date :** 6 juillet 2026 (état v1.1 — module calendrier inclus).
**Compléments :** ce document justifie les choix ; les références exhaustives restent
[`architecture/ARCHITECTURE.md`](architecture/ARCHITECTURE.md), les
[ADR](architecture/adr/), [`mobile/MOBILE-APP.md`](mobile/MOBILE-APP.md),
[`backend/API-CONTRACTS.md`](backend/API-CONTRACTS.md),
[`database/DATABASE.md`](database/DATABASE.md).

---

## 1. Vision — quel problème on résout

En poissonnerie de grande distribution, chaque arrivage doit être tracé (HACCP + règlement
INCO/PCP) : dénomination commerciale et scientifique, zone FAO précise, lot, DLC,
estampille sanitaire, etc. Aujourd'hui c'est de la saisie manuelle depuis des étiquettes
fournisseurs hétérogènes — lent et source d'erreurs.

**LabelScan** : l'opérateur photographie l'étiquette ; l'app extrait automatiquement
**17 champs réglementaires**, les lui fait **vérifier** (l'humain reste la vérité), puis
archive un enregistrement auditable. Deux principes non négociables structurent *tout* le
système :

1. **No-fabrication** — une donnée absente de l'étiquette est `null`, jamais devinée.
   Dans un contexte réglementaire, une donnée plausible mais fausse est pire qu'un trou.
2. **Immutabilité auditable** — on ne modifie jamais une donnée métier, on ajoute une
   version. La traçabilité historique est la raison d'être du produit.

Le public cible final est le grand compte (multi-magasins) ; l'état actuel est calibré
**pilote mono-utilisateur**, avec l'écart cartographié dans
[`PROD-READINESS.md`](PROD-READINESS.md).

---

## 2. Vue d'ensemble du système

Deux applications, une frontière HTTP nette :

- **Mobile** (`src/`, Expo/React Native, TypeScript) : capture, file de scans, revue,
  stockage local des articles validés, calendrier. *Client mince* : aucune extraction à
  bord.
- **Backend** (`server/`, FastAPI/PostgreSQL, Python 3.11) : ingestion durable,
  pipeline d'extraction asynchrone (GS1 + OCR + LLM), magasin autoritatif append-only,
  audit, auth.

Flux nominal : photo → `POST /v1/ingestions` (multipart, hash-idempotent) → ack immédiat
→ worker (outbox) : OCR Vision → gate qualité → **vague intermédiaire regex** → LLM
Claude → gate no-fab → réconciliation GS1 → `extraction_run` persisté → le mobile
(long-poll) affiche la revue → corrections humaines POSTées en append-only → article
enregistré localement.

### Pourquoi cette frontière-là ?

**Choix : extraction 100 % côté serveur.** Alternative écartée : OCR sur l'appareil
(historiquement présent, retiré). Trois raisons : (a) **sécurité** — toute variable
`EXPO_PUBLIC_*` est inlinée dans le bundle JS et extractible d'un build ; une clé Vision
côté client est une clé publique ; (b) **auditabilité** — le magasin de vérité (raw
avant normalisé, ADR-0003) doit voir passer la donnée brute ; (c) **évolutivité** — on
change de modèle/provider sans redéployer une app mobile. Coût assumé : dépendance
réseau + latence, traitée par un programme dédié (§9).

---

## 3. Choix techniques fondateurs (avec alternatives)

### 3.1 Mobile : Expo / React Native + TypeScript

- **Pourquoi** : un seul développeur, deux OS cibles, besoin fort caméra/gestes ; Expo
  (SDK 54, dev client) donne caméra, manipulation d'image, secure store, haptique sans
  code natif à maintenir ; TypeScript strict porte les contrats API dans le client
  (`src/types/api.ts` est un miroir du contrat backend).
- **Alternatives** : natif Swift+Kotlin (qualité max, coût ×2 inacceptable en solo) ;
  Flutter (bon candidat, écarté pour rester dans l'écosystème TS et partager les types
  avec les contrats HTTP) ; PWA (caméra et offline trop limités).
- **Limites assumées** : upgrades Expo ~2×/an (dette récurrente planifiée) ; Expo Go
  insuffisant (reanimated/caméra ⇒ dev client obligatoire) ; certaines APIs Web absentes
  du runtime RN — leçon apprise : le long-poll a crashé sur device parce que
  `URLSearchParams.toString()` n'existe pas dans le polyfill RN (passe santé du 3/07).
  Règle depuis : **aucune API Web non vérifiée RN dans le code device**.

### 3.2 Backend : FastAPI + PostgreSQL, monolithe modulaire hexagonal

- **Pourquoi FastAPI/Python** (ADR-0007) : écosystème IA (SDK Anthropic, httpx), typage
  Pydantic aux frontières, async natif pour le long-poll. Pourquoi **monolithe
  modulaire** et pas microservices (ADR-0001) : une équipe d'une personne, un domaine
  encore mouvant — les 6 bounded contexts (`ingestion`, `traceability`, `haccp`,
  `compliance`, `audit`, `identity`) vivent dans un process avec des **frontières
  outillées** : import-linter fait respecter adapters→application→domain et l'étanchéité
  inter-contextes (5 contrats, cassent le build). On garde la *possibilité* d'extraire
  un service plus tard, sans en payer le prix aujourd'hui.
- **Pourquoi PostgreSQL** (et pas un BaaS type Firebase/Supabase) : l'immutabilité est
  imposée **dans la base** (triggers `deny_mutation`, GRANTs minimaux) — un bug applicatif
  ne peut pas corrompre l'historique ; transactions sérieuses pour l'outbox ; requêtes
  d'audit SQL. Un BaaS aurait accéléré le début mais déporte les invariants critiques
  dans du code client, exactement ce qu'on refuse.
- **Limites** : pas de scaling horizontal automatique (2 workers compose, `SKIP LOCKED`
  prêt pour n) ; l'industrialisation (PG managé, secrets, CI/CD) est un chantier listé.

### 3.3 Pipeline d'extraction hybride : GS1 → OCR → LLM

- **Déterministe d'abord** : un code-barres GS1-128 lisible donne lot/DLC/GTIN/poids
  **exacts** — décodé sur l'appareil à T+0 (`services/gs1.ts`), et le serveur **ne laisse
  jamais le LLM contredire le code-barres** (réconciliation : GS1 gagne sur ses champs).
- **LLM ensuite** : Claude **Haiku** par défaut (rapport coût/latence), **escalade Opus**
  configurable sur les cas difficiles, prompt caching activé. Le prompt est un
  **contrat versionné** ([`extraction/PROMPT-CONTRACT.md`](extraction/PROMPT-CONTRACT.md),
  v2.0.0, 17 champs) avec cas de test d'or (`extraction/test-cases/`).
- **Gate no-fab côté serveur** : sortie LLM validée contre le texte OCR — un champ non
  ancré dans le texte est rejeté. La confiance est **dans le modèle** (ADR-0005 : chaque
  champ porte score + bande + provenance), mais l'UI ne l'affiche jamais (choix produit :
  l'opérateur vérifie tout, un score l'inciterait à ne vérifier que le rouge).
- **Alternatives** : OCR seul + regex (insuffisant sur étiquettes hétérogènes) ; LLM
  vision direct sans OCR (coût + no-fab invérifiable sans texte ancré) ; fine-tuning
  (prématuré sans corpus).

### 3.4 Asynchronisme : outbox transactionnel + long-poll

- L'ingestion **ack vite** (payload brut persisté, hash-idempotent) et délègue au worker
  via une **outbox en base** (même transaction que l'écriture métier — jamais de message
  fantôme ; retries bornés + DLQ). Alternative écartée : broker (RabbitMQ/Redis) — une
  dépendance d'infra de plus sans besoin de débit.
- Le mobile suit l'avancement par **long-poll** (`GET /v1/ingestions/{id}?wait=…`,
  hold serveur ≤25 s, sonde ~300 ms, aucune connexion de pool retenue) — latence de
  découverte ~0 sans WebSocket. **Anti-spin** : un hold qui revient trop vite (vieux
  serveur) fait retomber en cadence ~1 s. Upgrade path documenté : LISTEN/NOTIFY puis
  SSE quand la flotte grossit.

### 3.5 Données : append-only partout, event sourcing nulle part

ADR-0004 : l'event sourcing complet (rejouer l'état depuis les événements) a été pesé et
écarté — complexité de projection injustifiée. À la place : **tables append-only +
journal d'audit** (qui, quoi, quand, contexte) — 90 % du bénéfice pour 20 % du coût.
Corrections humaines = nouveau `extraction_run` `source='human'` ; champs GS1 modifiables
uniquement sous flag explicite `force_gs1` avec action d'audit dédiée (l'opérateur peut
corriger un code-barres endommagé, mais ça se voit).

---

## 4. Organisation du code

```text
LabelScan/
├── App.tsx, index.ts          # entrée mobile (fonts, lifecycle file de scans, drain outbox)
├── src/
│   ├── screens/               # 5 écrans (List, Detail, Camera, Review, Login)
│   ├── components/            # UI réutilisable (cartes, calendrier, visionneuse, skeletons…)
│   ├── services/              # LE cœur : I/O (api, scanQueue, outbox, storage…)
│   │                          #   + helpers PURS testés (calendar, gs1, inputMasks…)
│   ├── hooks/                 # useScanQueue, useArticleSearch
│   ├── context/               # AuthContext (seul contexte React)
│   ├── navigation/            # RootNavigator (pile unique)
│   ├── theme/                 # tokens (couleurs, typo, espacements, élévation)
│   ├── types/                 # api.ts (miroir contrats), Article.ts (modèle local)
│   └── __tests__/             # 22 suites jest, logique pure uniquement
├── server/
│   ├── src/labelscan/
│   │   ├── contexts/<ctx>/{domain,application,adapters}/   # hexagone par contexte
│   │   ├── platform/          # http (sécurité, erreurs), db, outbox — mutualisé
│   │   └── app/               # composition root (http_app, worker_runtime, config)
│   ├── migrations/            # Alembic 0001→0013 (SOURCE DE VÉRITÉ du schéma)
│   ├── tests/                 # 242 tests dont proofs sur vraie base
│   └── scripts/run_local_proofs.sh   # PG 16 éphémère + migrations + lint-imports + pytest
└── docs/                      # ADR, contrats, DB, pipeline, mobile, audits
```

Règle de lecture mobile : **un écran ne contient pas de logique métier** — il câble des
services purs (testés) et des composants. Quand un écran grossit quand même (Review :
957 lignes), c'est du JSX + câblage, pas de la logique cachée ; le découpage est au
backlog (audit v1.1, reco 7).

---

## 5. Modèle de données (l'équivalent « structure Firebase »)

### Côté serveur (PostgreSQL, schéma par contexte)

- `ingestion.ingestion` — une capture soumise : statut (machine **12 états** :
  `received → raw_stored → ocr_running → ocr_done → extraction_running → extracted /
  needs_review / ocr_failed / rejected / halted_missing_context / confirmed …`), hash de
  contenu (dédup), pointeur raw store.
- `ingestion.extraction_run` / `extracted_field` — **versions** successives du résultat ;
  un run par passe (machine, puis humaine), chaque champ avec valeur, confiance, bande,
  provenance (`gs1` / `llm` / `human`), statut de validation. Jamais d'UPDATE.
- `ingestion.interim_field` (0012) — aperçu déterministe (regex post-OCR) **non
  autoritatif**, exposé uniquement tant qu'aucun run n'existe.
- `ingestion.request_idempotency` (0013) — clé d'idempotence par (endpoint, actor, key) :
  un retry rejoue la réponse d'origine, même hors-ordre.
- `identity.app_user`, `audit.*` — comptes (seam actuel : admin unique) et journal.
- Outbox transactionnel (`platform/outbox`) — file worker avec retries/DLQ.

### Côté mobile (AsyncStorage, local-first)

- **`Article`** (`src/types/Article.ts`) : l'enregistrement **validé par l'humain** —
  17 `ArticleField` (valeur + provenance + `edited`), photo locale, `saved_at` (clé du
  calendrier), `raw_extraction_run` conservé hors chemin chaud. Une clé de stockage par
  article (`@labelscan:article:<id>`), derrière le **port `ArticleStore`** (adaptateurs
  AsyncStorage aujourd'hui, SQLite demain, mémoire pour les tests).
- **`PendingScan`** (file `scanQueue`) : un scan pas encore validé — photo durable,
  statut, brouillon `edits` persistant. Un scan **n'est jamais** un article avant 17/17.
- **Outbox mobile** : écritures de revue (overrides, confirms) rejouées au retour réseau
  avec clés stables, purge des opérations terminées.

**Flux CRUD, en une phrase chacun** : *Create* = POST multipart idempotent + pipeline
async ; *Read* = long-poll statut + `latest_fields` embarqués (pas de 2ᵉ fetch) ;
*Update* = jamais (append d'un nouveau run via PATCH champ / POST confirm) ; *Delete* =
uniquement local mobile (le serveur ne détruit rien — doctrine).

---

## 6. Gestion d'état mobile — pourquoi pas Redux

Trois familles d'état, trois outils délibérément différents :

1. **État serveur en transit** (scans en cours) : singletons module + abonnés
   (`scanQueue.ts`, `outbox.ts`) exposés via **`useSyncExternalStore`**. Pourquoi : cet
   état doit **survivre aux écrans** (la file continue pendant qu'on navigue), être
   persisté, et piloter des effets (sondages long-poll plafonnés à 3, pause/reprise sur
   `AppState`). Un store React (Redux/Zustand) n'apporterait que de l'indirection — il
   faudrait quand même le singleton pour le cycle de vie hors-React.
2. **État d'écran** : `useState`/`useMemo` locaux (recherche, jour sélectionné, panneaux).
   Éphémère par nature, aucune raison de le globaliser.
3. **Auth** : un seul `Context` React (`AuthContext`) — vraiment global, change rarement.

Alternatives pesées : Redux Toolkit (boilerplate sans bénéfice à cette échelle),
TanStack Query (élégant pour du fetch déclaratif, mais notre « fetch » est une machine à
états long-poll avec effets — le singleton la modélise mieux). Limite assumée : la
discipline remplace le framework ; si l'équipe grossit, re-poser la question.

## 7. Navigation

**Une pile unique** (`@react-navigation/stack`) : `ArticleList` (home) → `ArticleDetail`
(lazy) / `Camera` / `Review` (modal). Pas de tab bar : le produit a UN flux central
(scanner → vérifier → archiver), les fonctions secondaires (recherche, calendrier,
export) vivent dans l'app bar du home — le calendrier v1.1 est un **sélecteur qui
re-scope le home**, pas une page (décision : zéro navigation pour changer de jour).
Règle forte : `Review` ne reçoit **qu'un `pendingScanId`** — les données sont lues en
direct dans la file (une seule source de vérité, l'écran survit à un changement d'état
pendant qu'il est démonté).

## 8. UI / design system

Tokens dans `src/theme/` (base neutre + **un** bleu accent #2563EB ; couleur = état,
jamais décoration ; Inter ; hairlines plutôt qu'ombres). Décision produit forte :
**aucun indicateur de confiance IA à l'écran** (pas de score, pas de « à vérifier ») —
la validation humaine est LA vérité, un score biaiserait la vigilance. Le calendrier
suit la même grammaire : l'intensité de bleu (rampe du token primary) est le seul
signal de volume, la sélection est un anneau discret. Animations : RN `Animated` natif,
150-250 ms (reanimated réservé aux gestes — swipe, visionneuse pinch/pan).

## 9. Performance — la latence perçue comme programme

La mesure (juin) donnait ~20 s perçues par scan, dominées par l'egress Docker-macOS
(caveat documenté : à re-mesurer en prod-like). Plutôt que d'attendre l'optimisation
brute, la latence a été traitée par **recouvrement** :

- **Soumission spéculative** : l'upload part à la prise de photo, pas à la validation
  (`overlap_ms` loggé pour le prouver).
- **Cascade 3 vagues** : GS1 à T+0 → aperçu regex à ~2 s (`interim_field`) → LLM.
  L'écran se remplit en continu, **zéro layout shift** (16 lignes stables, skeletons
  remplacés en place), formes canoniques identiques regex/LLM → jamais de flicker.
- **Long-poll** : ~0 s de latence de découverte des transitions.
- Micro-optimisations mesurées : image ≤1600 px, `httpx.Client` partagé (−600 ms/appel),
  prompt caching, fix du formatteur de logs qui masquait le split OCR/LLM.
- Côté rendu : FlatList O(1) (`getItemLayout` + hauteurs fixes **mesurées**),
  `React.memo` cartes, `useDeferredValue` recherche, filtre calendrier en mémoire.

## 10. Sécurité — posture et trous connus

**Fait** : extraction et clés 100 % serveur (rien d'extractible dans le bundle — l'OCR
client et sa clé ont été *supprimés*, pas cachés) ; JWT (login → Bearer, secure store) ;
seam header-auth **désactivé par défaut** ; `.env` git-ignorés et vérifiés absents de
tout l'historique ; immutabilité par triggers ; validation Pydantic aux frontières ;
erreurs problem+json sans fuite d'interne.

**Trous connus et assumés (audit v1.1)** : rotation de la clé Vision encore due (P0) ;
pas de rate limiting sur l'auth (P0) ; mono-compte admin sans refresh/révocation (Phase
1 : identité nominative + RBAC) ; secrets en `.env` (industrialisation) ; TLS délégué au
frontal de déploiement.

## 11. Tests — la stratégie et son angle mort

- **Mobile (212)** : uniquement de la **logique pure** (jest/ts-jest, node). Choix :
  les tests de rendu RN (testing-library + mocks natifs) coûtent cher et cassent pour
  de mauvaises raisons ; à la place, toute logique est *extraite* pour être testable, et
  le rendu réel se valide **sur device** via des checklists explicites (fin de
  `CLAUDE.md`). **Angle mort assumé** : entre deux sessions device, le JSX n'est couvert
  que par le typage — d'où la discipline de checklists, à purger avant toute release.
- **Backend (242 + import-linter)** : `run_local_proofs.sh` monte un **PG 16 éphémère**,
  applique les migrations, vérifie les frontières, puis pytest — y compris des *proofs*
  d'immutabilité (tenter un UPDATE et vérifier le refus par trigger) et des tests
  d'intégration par invariant (idempotence, long-poll, interim, confirm). Tester contre
  une vraie base est le seul moyen de tester des triggers — c'est voulu.

## 12. Compromis principaux (résumé honnête)

| Compromis | Gagné | Payé |
|---|---|---|
| Client mince, extraction serveur | sécurité, audit, évolutivité modèle | latence réseau, offline partiel |
| Monolithe modulaire outillé | vélocité solo, frontières réelles | pas de scaling indépendant |
| Append-only partout | intégrité prouvable | volumétrie croissante, requêtes « dernier état » plus complexes |
| Haiku + escalade | coût/scan bas | qualité à surveiller (éval continue à bâtir) |
| Long-poll | simple, robuste | charge ∝ devices (SSE prévu) |
| Tests purs sans rendu | suite rapide, stable | checklists device obligatoires |
| AsyncStorage + port | livré vite, migration préparée | plafond ~qq milliers d'articles |
| Pas de CI (discipline locale) | zéro infra | dérive silencieuse possible — quick win n° 1 |

## 13. Pistes d'amélioration (ordre recommandé)

Reprise de l'audit v1.1 : (1) P0 sécurité — rotation clé, rate limit auth, session
device ; (2) hygiène — code mort (`ScanStepper`, flag `BACKEND_FIRST`,
`expo-status-bar`), factorisation `SwipeToDelete`/`HeaderSlidePanel`, CI GitHub Actions +
ESLint ; (3) structurant — découpage `ReviewScreen`, `SqliteArticleStore`, re-mesure
latence puis SSE ; (4) produit — Phase 1 identité/RBAC → multi-tenant → industrialisation
(jalons pilote ≈ S6, contrat groupe ≈ M3-5 dans
[`IMPLEMENTATION-ROADMAP.md`](IMPLEMENTATION-ROADMAP.md)).

---

*Fin de la revue. Pour la chronologie détaillée des décisions (qui a changé quoi, quand,
avec quelles preuves), le journal `CLAUDE.md` à la racine reste la source narrative.*
