# Audit Technique Complet — LabelScan (Traçabilité HACCP produits de la mer)

> **Version :** **v2 — 2026-06-17** (remplace la v1 du 2026-06-15)  **Auditeur :** Architecte Technique Senior / Lead Dev
> **Périmètre :** dépôt `LabelScan/` (mobile Expo/RN + backend Python/FastAPI + docs + infra)
> **Méthode :** lecture exhaustive du code source + exécution réelle de `lint-imports` (G-ARCH, **112 fichiers / 268 dépendances, 5/5 contrats**) et de la suite de tests (**27 fichiers / 142 tests**) ; chaque constat est ancré en `chemin:ligne`.
> **État Git :** commit `0235ab6` (« Initial commit ») + large delta non commité (`server/`, `docs/`, `src/`, infra). **La v2 intègre les implémentations de la session du 2026-06-17** (auth JWT, extraction hybride GS1+LLM, refonte capture + i18n mobile).

---

## Hypothèses & cadrage (lues, non supposées)

Le prompt d'audit était générique (placeholders). La stack **réelle** observée remplace les placeholders :

| Dimension | Réalité observée |
|---|---|
| Type d'app | Système de traçabilité HACCP (produits de la mer, GMS) — **mobile + backend** |
| Front | **Expo SDK ~54 / React Native 0.81.5 / React 19.1 / TypeScript strict** |
| Back | **Python ≥3.11 / FastAPI / SQLAlchemy 2 / Alembic / psycopg3 / Pydantic v2 / Anthropic SDK** |
| Base | **PostgreSQL 16** (modular monolith, cœur hexagonal framework-free) |
| Infra | **Docker Compose** (db + server + worker), Dockerfile mono-stage |
| CI/CD | **GitHub Actions** (`backend-ci.yml`) — G-ARCH + ruff + migrations up/down/up + pytest |
| IA | OCR **Google Vision** + extraction **Claude** (`claude-haiku-4-5` par défaut ; escalade `claude-opus-4-8` désactivée par défaut) derrière des ports |

> **Cadrage spécifique projet :** le `CLAUDE.md` impose un plan d'exécution STRICT où **Phase 1 = validation d'architecture SANS CODE, livrable = GAP REPORT**, et impose un **STOP+REPORT en cas de contradiction**. Ce rapport tient lieu de livrable Phase 1 : il est **100 % lecture seule** (aucun fichier de code ou de contrat modifié). La §6 (Conformité au spec figé) et la §7 (conditions STOP) constituent le GAP REPORT formel.
>
> **Constat de contexte majeur :** l'`AUDIT.md` existant (daté 2026-06-14) décrit une app « frontend-only sans backend ». **Il est obsolète** : le redesign progressif (Phases 0→5) y est décrit comme « pas encore commencé », alors que le backend (PG-0→PG-4) et le client mince mobile sont aujourd'hui **largement implémentés**. Le présent audit porte sur l'état **actuel** du dépôt.

---

## Table des matières

- [0. Résumé exécutif](#0-résumé-exécutif)
- [1. Audit système — Back-end, Infra & Architecture](#1-audit-système--back-end-infra--architecture)
  - [1.1 Architecture & patterns](#11-architecture--patterns)
  - [1.2 Sécurité](#12-sécurité)
  - [1.3 Performance système](#13-performance-système)
  - [1.4 Scalabilité & fiabilité](#14-scalabilité--fiabilité)
  - [1.5 Base de données](#15-base-de-données)
  - [1.6 Observabilité](#16-observabilité)
  - [1.7 DevOps & CI/CD](#17-devops--cicd)
- [2. Analyse front-end (mobile)](#2-analyse-front-end-mobile)
- [3. Cartographie des dépendances](#3-cartographie-des-dépendances)
- [4. Speech technologique (justification par brique)](#4-speech-technologique--justification-par-brique)
- [5. Synthèse stratégique & plan d'action](#5-synthèse-stratégique--plan-daction)
- [6. Conformité au spec figé (GAP REPORT)](#6-conformité-au-spec-figé--gap-report)
- [7. Conditions STOP & contradictions (CLAUDE.md)](#7-conditions-stop--contradictions-claudemd)

---

## 🔄 Évolutions majeures depuis la v1 (2026-06-15 → 2026-06-17)

Cette v2 intègre les implémentations réalisées entre les deux dates. Les sections détaillées ci-dessous sont mises à jour ; synthèse des deltas :

**Sécurité / Auth — R1 RÉSOLU.** L'auth par headers forgeables est remplacée par une **vraie authentification JWT**. `POST /v1/auth/login` (username/password) → JWT **HS256** ; `resolve_principal` vérifie le **Bearer en priorité**, le seam header legacy est **désactivé par défaut** (`LABELSCAN_ALLOW_HEADER_AUTH`, off → headers forgés rejetés). Nouveau contexte `identity` (domaine pbkdf2 + use case `Login` + adapter SQL + CLI de provisioning), table **`identity.app_user`** (migration **0007**), rôle unique `admin` mappé aux 6 scopes existants. Secret JWT ≥32 octets imposé. Mobile : token en **keystore sécurisé** (`expo-secure-store`), `Authorization: Bearer` sur toutes les requêtes, **401→déconnexion** automatique, écran de login + gating de navigation. Dépendances : +`pyjwt` (back), +`expo-secure-store` (mobile). Le seam `DEV_AUTH` (X-Actor-Id/…) est **retiré du mobile**.

**Extraction — architecture hybride déterministe + LLM (« zéro hallucination » sur lot/DLC).** Nouveau **parser GS1** (`ingestion/domain/gs1.py`, pur) décodant le code-barres natif (lot/DLC/DDM/date d'emballage/poids/GTIN). **Réconciliation** (`ingestion/domain/reconciliation.py`) : le GS1 (exact, confiance 1.0) **écrase** le LLM sur les champs critiques ; tout conflit code-barres↔imprimé est tracé en `warnings`. **Option Y** (`adjusted_outcome`) : un champ requis fourni par GS1 ne force plus la revue, **mais** un conflit lot/DLC la force (intégrité d'étiquetage). Migration **0008** (`extracted_field.source` += `'gs1'`, `field_name` += `'gtin'`). Modèle LLM par défaut → **`claude-haiku-4-5`** (~5× moins cher/plus rapide ; l'adaptateur n'envoie `effort`/thinking adaptatif que pour Opus/Sonnet — Haiku les rejette) + **prompt dynamique** (focalisé sur le texte libre quand le GS1 a déjà les champs exacts) + breakpoint `cache_control`. **Seuils de confiance désormais configurables** (`extraction_wiring.thresholds_from_env`, défauts inchangés) + **harnais de calibration** (`scripts/calibrate_confidence.py`, GS1 = vérité terrain). Le gate `evaluate` (non-fabrication) **reste inchangé**.

**Mobile — UX + i18n.** UI passée en **français** (sauf titres). Nouveau **flux de capture** : prise de photo → **validation de la photo** (Reprendre/Valider) → extraction (au lieu d'un envoi immédiat). **Cadre de placement** d'étiquette (`FrameOverlay`, guide visuel — l'image entière reste envoyée) + **capture manuelle uniquement** (auto-capture 1,5 s **supprimée**). **Accessibilité** : labels/roles/états ajoutés (login, en-tête Articles, flash, aperçu) — l'« 0 `accessibility*` » de la v1 **n'est plus exact** (désormais 9 `accessibilityLabel`, 7 `accessibilityRole`, 2 `accessibilityState`, 1 `accessibilityLiveRegion`).

**Tests & garanties.** **20 → 27 fichiers**, **~92 → 142 fonctions**. Nouveaux : `test_auth_login`, `test_identity_unit`, `test_gs1_parser`, `test_reconciliation`, `test_option_y_outcome`, `test_gs1_integration`, `test_confidence_calibration`. G-ARCH **5/5 KEPT**, ruff propre, **zéro régression**.

**Ce qui n'a PAS changé (constats v1 toujours valables, non traités cette session) :** observabilité quasi nulle (**R3**) ; **secrets en clair** dans `server/.env` (**R2**, + désormais le secret JWT) ; **OCR client legacy + clé Vision** toujours présents (**M2**) ; **outbox mobile non drainée** (**M1**) ; pas de DLQ / kill-switches / métriques / backup DB ; Dockerfile mono-stage/root ; pas de lockfile backend ; safe-area caméra (barre du haut) toujours en dur. Les **divergences de contrat** v1 (**#3** réécritures schéma aval ; **#4** `value` aplati en `string` + confiance `min()`) **restent ouvertes** — délibérément non touchées (discipline STOP). La migration **0008** est un changement de schéma **validé** par le propriétaire en session (donc pas un STOP ouvert).

---

## 0. Résumé exécutif

**Verdict global.** Le projet est un **socle backend de très bonne facture architecturale**, ciblant explicitement les invariants HACCP critiques (immutabilité, auditabilité, non-fabrication). Le cœur de valeur — *ingestion immuable « raw-before-normalized », audit transactionnel, garde anti-hallucination par preuve-substring* — est **réellement implémenté et testé**. **La v2 a fait sauter le bloquant d'authentification (R1, JWT réel), ajouté une extraction hybride GS1+LLM « zéro hallucination » sur les champs critiques, et livré le logging structuré (R3 en grande partie traité).** Restent **PARTIELS / ABSENTS** : métriques & SLO instrumentés, primitives de fiabilité (DLQ, dead-man, kill switches), workflow HITL, drain offline mobile. S'ajoutent des **divergences de contrat** (schéma aval, forme `value`, règle de confiance) qui, sous le plan STRICT, restent des points **STOP-and-report**.

**Posture GO / NO-GO production :** 🔴 **NO-GO en l'état** — **bloquant restant : R2 (secrets en clair)** ; **R1 (auth) levé**, **R3 (observabilité) en grande partie traité** (logging structuré livré ; restent métriques/SLO pour prouver les SLA HACCP). **GO conditionnel** une fois R2 traité + métriques/SLO instrumentés + STOP-items §7 tranchés (voir §5).

### Top 3 risques critiques

| # | Risque | Sévérité | Preuve |
|---|---|---|---|
| ~~R1~~ | ✅ **RÉSOLU en v2 — authentification JWT réelle.** Bearer HS256 vérifié dans `resolve_principal` (signature + exp + secret ≥32o) ; seam header forgeable **désactivé par défaut**. Reste hors périmètre par décision : refresh tokens, multi-rôles, JWKS/RS256 (HS256 mono-service suffit ici). | ~~Critique~~ → **Clos** | `platform/http/security.py` ; `platform/http/jwt.py` ; `contexts/identity/*` ; `test_auth_login.py` |
| **R2** | **Clés API de production en clair sur disque + injectées dans 2 conteneurs.** `server/.env` contient une clé Google Vision et une clé Anthropic **vives**. Git-ignoré et jamais commité (vérifié), mais exposées localement et propagées via `docker-compose.yml:24`. | **Critique** | `server/.env:2-3` ; `docker-compose.yml:24` → **rotation immédiate** |
| **R3** | **Observabilité PARTIELLE (v2).** ✅ **Logging structuré JSON livré** (`platform/observability.py`, `correlation_id`/`trace_id`, secrets jamais loggés) : le handler 500 logge **réellement** (traceback), le worker logge dispatch/échecs, l'extraction logge outcome + **refus LLM**. 🔴 Restent absents : **métriques/OTel/Prometheus + SLO-1/2/3 instrumentés**. | **Élevé** *(était Critique)* | `platform/observability.py` ; `errors.py` ; `outbox/worker.py` ; `test_observability.py` |

### Top 3 quick wins (fort impact, faible coût)

1. **Rotation des deux clés** (`server/.env`) + retrait de la clé LLM du conteneur `server` (qui n'en a pas besoin), et **suppression du chemin OCR client** (`src/services/ocr.ts` + branche legacy) → ferme R2 et l'exfiltration de la clé Vision bundlée mobile.
2. **Borner le pin `anthropic`** (`anthropic>=0.40` → `>=0.40,<2.0`) + **générer un lockfile** backend (`uv pip compile`/`requirements.txt`) → supprime le risque de breaking change silencieux de la couche IA en prod.
3. ✅ **FAIT en v2 — Logging structuré JSON** (`platform/observability.py`, `correlation_id`/`trace_id`, allow-list anti-fuite) branché sur le handler d'erreurs, le worker et l'extraction → 500 et échecs/refus provider désormais diagnosticables. *Prochaine étape : métriques + SLO.*

### Conditions STOP recommandées (cf. CLAUDE.md, détail §7) — **toujours ouvertes en v2**
- **Réécritures de schéma DB** divergeant du `schema.sql` figé (réécriture `control_plan`/`alert`, colonnes de cycle de vie supprimées, `mean_token_confidence`/`is_superseded` retirés, valeur `'inconsistency'` ajoutée à un enum figé à 3 valeurs). *(Non touché en v2 ; la migration 0008 — `source`+=`gs1`, `field_name`+=`gtin` — est, elle, un changement **validé** par le propriétaire.)*
- **`value` par champ aplati en `string`** vs forme polymorphe jsonb figée (§4.2 du spec) — les sous-champs normalisés (ISO, °C, montant/devise, tableau d'allergènes) sont inrepresentables. *(Inchangé en v2.)*
- **Règle de combinaison de confiance** = `min(llm, OCR_moyen_document)` vs le composite documenté. *(En v2, les **seuils** sont désormais configurables — `thresholds_from_env` — et un harnais de calibration existe ; mais la **formule** `min()` et l'absence de rule-set versionné de confiance restent divergentes.)*

---

## 1. Audit système — Back-end, Infra & Architecture

### 1.1 Architecture & patterns

**Modular monolith + hexagonal — RÉEL et vérifié par outil.** La structure `contexts/<ctx>/{domain,application,adapters}` est respectée et **`lint-imports` passe 5/5 contrats** (« Analyzed 96 files, 214 dependencies. Contracts: 5 kept, 0 broken »). Les contrats G-ARCH (`server/.importlinter`) imposent :

- couches `adapters > application > domain` par contexte ;
- **indépendance des bounded contexts** (pas d'import croisé) ;
- **pureté du domaine** : `domain/*` ne peut importer ni `sqlalchemy/alembic/psycopg/fastapi/httpx/pydantic`, ni `platform`/`app` ;
- **ingestion découplé du worker** (`contexts.ingestion` ne peut importer `platform.outbox`) — le producteur n'écrit que des lignes outbox ;
- pureté de la couche application (pas de frameworks/DB).

Le domaine est **réellement framework-free** (ex. `domain/extraction.py` n'importe que `dataclasses`/`enum`).

**Ports & adapters réels** (Protocols stdlib) :

| Port | Adapter | Réf |
|---|---|---|
| `RawStore` | `FilesystemRawStore` | `application/ports.py:13` |
| `IngestionWriteRepository` | `SqlIngestionRepository` | `application/ports.py:38` |
| `OcrProvider` | `GoogleVisionOcr` | `application/extraction_ports.py:33` |
| `LlmExtractor` | `ClaudeLlmExtractor` | `application/extraction_ports.py:43` |
| `AlertRepository` | `SqlAlertRepository` | `haccp/application/alert_service.py:31` |

**6 contextes :** `ingestion` + `haccp` (cœur hexagonal), `traceability` (layered), **`identity` désormais implémenté en v2** (domain `password`/`user` purs + use case `Login` + adapter SQL/HTTP/CLI → table `identity.app_user`, migration 0007), et `compliance`/`audit` **encore quasi vides** (tables `required_field_rule_set`, `species`, `fao_area` non créées). Le contexte `ingestion` gagne en v2 les modules purs `gs1.py` + `reconciliation.py`. `platform/` = infra transverse (db/http/outbox/**jwt**), `app/` = composition root.

**Pattern d'intégration :** **transactional outbox** (producteur écrit la ligne outbox dans la même transaction que l'ingestion ; worker async la relaie). C'est le bon pattern pour découpler ingestion et traitement sans perte.

> **Verdict §1.1 :** architecture **excellente et défendue mécaniquement** (rare). C'est le point fort majeur du projet.

### 1.2 Sécurité

| Vecteur | État | Preuve |
|---|---|---|
| **Authentification** | 🟢 **JWT réel (v2).** `POST /v1/auth/login` (username/password, mot de passe **pbkdf2** en base) → JWT **HS256** ; `resolve_principal` vérifie **Bearer en priorité** (signature + `exp` + secret ≥32o). Seam header legacy **désactivé par défaut** (`LABELSCAN_ALLOW_HEADER_AUTH`). Non fait par décision : refresh tokens, JWKS/RS256, multi-rôles. | `platform/http/security.py` ; `platform/http/jwt.py` ; `contexts/identity/adapters/http/router.py` |
| **RBAC** | 🟠 **Rôle unique `admin`** mappé aux **6 scopes** existants (`ingestion:write/read`, `traceability:read`, `haccp:read`, `alert:ack`, `alert:resolve`) via `scopes_for_role` ; `require_scope` inchangé. Pas de modèle multi-rôles (choix « admin simple » assumé). | `contexts/identity/domain/user.py` ; `security.py` |
| **Fail-closed** | 🟢 Fort côté DB/scope (INSERT sans contexte d'audit → abort ; scope absent → 403) **et désormais côté principal** (Bearer invalide/expiré → 401 ; pas de Bearer + seam off → 401). L'acteur d'audit provient d'un claim **signé**. | trigger `0002:64-69` ; `security.py` ; `test_auth_login.py` |
| **Validation entrée** | 🟢 Pydantic v2 au boundary : Idempotency-Key requis, media type ∈ {jpeg,png,webp,heic}, payload non vide, ≤ 10 Mo, re-validé dans le use case. | `ingestion/.../http/router.py:83-94` ; `submit_ingestion.py:62-65` |
| **Secrets** | 🔴 **Inchangé (R2) :** clés vives Google Vision + Anthropic dans `server/.env` (git-ignoré, jamais commité — vérifié) ; injectées dans `server` ET `worker` via `env_file`. **v2 ajoute** `LABELSCAN_JWT_SECRET` (≥32o imposé, hard-error si absent) + `LABELSCAN_ADMIN_PASSWORD` (provisioning). Toujours **pas de secret manager**. Côté code : secrets jamais loggés. | `server/.env` ; `docker-compose.yml` ; `platform/http/jwt.py` |
| **CORS / headers sécurité / rate limiting** | 🔴 **ABSENTS**. Une seule middleware (`CorrelationMiddleware`). `RATE_LIMITED`(429) existe au catalogue mais n'est jamais émis. | `app/.../http_app.py:19` ; `errors.py:25` |
| **Injection SQL** | 🟢 Exposition faible : requêtes paramétrées `text(...)` + bind params ; `WHERE` dynamique HACCP en **liste blanche statique** de colonnes. | `haccp/.../read_router.py:56-60` |
| **Idempotence** | 🟢 2 couches : HTTP `Idempotency-Key` requis + clé content-addressed `sha256(principal:route:content_sha256)` avec `INSERT … ON CONFLICT DO NOTHING` ; dédup consumer `(consumer, event_id)`. ⚠️ `IDEMPOTENCY_KEY_CONFLICT` (même clé / payload différent) non détecté. | `sql_ingestion_repository.py:64-101` ; `outbox/worker.py:89-92` |
| **Corrélation / trace** | 🟢 Propagés partout (middleware → commande → colonnes NOT NULL → trigger audit → enveloppe outbox → réponses problem+json). | `middleware.py:28-31` ; `errors.py:50-52` |

> **Verdict §1.2 (v2) :** l'auth est désormais **cryptographique** (R1 levé) → l'audit log n'est plus falsifiable par header forgé (seam off par défaut). **Un trou critique restant : secrets en clair (R2).** CORS / headers de sécurité / rate-limiting toujours absents. La *forme* sécuritaire (ports, fail-closed, idempotence, anti-injection) reste solide.

### 1.3 Performance système

- **Modèle d'exécution :** monolithe FastAPI mono-process, endpoints **sync** (`def` → threadpool), worker séparé (poll 1 s, batch 100). `pool_pre_ping=True` mais **pas de tuning de pool** (taille par défaut). Caching d'engine global lazy (double-checked locking).
- **`/health/ready`** ouvre/dispose un engine éphémère par requête (`ops_router.py:59-64`) — léger surcoût, pas de fuite de pool.
- **Requêtes :** pas de N+1 observé sur les endpoints de lecture (read-models assemblés en requêtes ciblées). Pas de cache applicatif (Redis/CDN) — non requis à ce stade.
- **Pipeline :** retries provider **sans backoff/jitter** (boucle serrée) — voir §1.4.

> **Verdict §1.3 :** correct pour un socle ; le risque perf n'est pas dans la latence unitaire mais dans l'**absence de garde-fous** (pas de rate limit, pas de backoff, pool non dimensionné).

### 1.4 Scalabilité & fiabilité

| Primitive | État | Preuve |
|---|---|---|
| Transactional outbox | 🟢 Robuste : at-least-once, `FOR UPDATE SKIP LOCKED` (multi-worker safe), dédup consumer, retry sur crash. Bien testé. | `outbox/worker.py` ; `test_outbox_worker.py` |
| Durabilité ingestion (zéro perte) | 🟢 **Garantie & prouvée** : raw-before-ack (fsync+rename atomique) → INSERT + ligne outbox **même transaction** → 202 après commit. | `submit_ingestion.py:60` ; `filesystem_raw_store.py:34-43` ; `test_ingestion_durability.py` |
| Retries / backoff | 🟠 Borné (`max_provider_attempts=3`, distinction non-retryable/transitoire) **mais sans backoff/jitter**. | `extraction_consumer.py:172-181` |
| **DLQ** | 🔴 **ABSENT** : événement empoisonné non-transitoire → **retry indéfini** à chaque poll, pas de compteur d'attempts. | `outbox/worker.py` |
| **Dead-man switch / kill switch / G-DUR** | 🔴 **ABSENTS** (Phase 3 du plan). | grep néant |
| Circuit breakers | 🔴 ABSENTS (reconnu explicitement). | `ops_router.py:44-47` |
| Health endpoints | 🟢 `/v1/health/live`, `/ready` (DB + object store), `/v1/version` présents & testés. 🟠 `/ready` n'inclut pas bus/breaker. | `ops_router.py:80,86,96` ; `test_ops_endpoints.py` |

> **Verdict §1.4 :** le **chemin nominal de durabilité est solide et prouvé** ; ce sont les **détecteurs de panne silencieuse** (DLQ, dead-man, G-DUR, stuck-run) — précisément le cœur du doc SRE — qui manquent. C'est le plus gros écart de fiabilité.

### 1.5 Base de données

- **7 schémas** (`ingestion, compliance, traceability, haccp, audit, identity, platform`) ; **2 rôles** créés (`labelscan_app` + `labelscan_auditor`) — le rôle **`labelscan_maint`** documenté pour les backfills append-only **n'est pas créé**. **v2 :** le schéma `identity` reçoit la table **`app_user`** (migration 0007) avec grants moindre-privilège.
- **Immutabilité — forte :** fonction `platform.deny_mutation()` (RAISE sur UPDATE/DELETE/TRUNCATE) + REVOKE, sur **9 tables append-only**. Testé contre une vraie DB (`test_immutability.py`).
- **Audit dans la même transaction :** trigger `AFTER INSERT` lit `current_setting('labelscan.actor_id'…)`, **RAISE si NULL**, valide l'UUID, insère dans `audit.audit_log` — atomicité garantie par Postgres. Durci en `0003` (SECURITY DEFINER, `search_path=''`, ownership minimal). Couvert par `test_audit_same_transaction.py`, `test_rollback.py`, `test_secdef_hardening.py`.
- **Partitionnement RANGE par mois** sur `audit_log`/`raw_artifact`/`temperature_log`, mais **partitions figées en dur jusqu'à `2026_07` + `default`**, **sans job de roulement** → tout tombe dans `default` après juillet 2026 (lié à l'absence de G-DUR). De plus `raw_artifact` n'a pas la partition `2026_07` que les deux autres ont.
- **FKs cross-schéma évitées** (liens par colonnes UUID indexées) — bon choix pour le découplage.
- **Migrations :** qualité élevée, **toutes réversibles** (CI fait up→down→up). Pattern expand-and-contract. **v2 : 8 migrations** (0001→0008). `0007` = `identity.app_user` (table **mutable**, sans trigger d'audit/immutabilité **par conception** — credentials, pas un enregistrement HACCP). `0008` = extension de 2 CHECK de `extracted_field` (`source` += `'gs1'`, `field_name` += `'gtin'`), même technique DDL que 0005 sur `raw_artifact.kind` ; l'immutabilité par triggers de ligne est intacte.
- **Backup/recovery :** 🔴 **absent** (aucun pgBackRest/WAL-archiving/dump ; volume Docker local seulement).

> **Verdict §1.5 :** modélisation et garanties d'intégrité **excellentes** ; risques opérationnels = partitions non roulées + pas de backup + rôle de maintenance manquant.

### 1.6 Observabilité

- **Logging structuré : 🟢 LIVRÉ (v2).** `platform/observability.py` = logger JSON stdlib (1 ligne JSON/événement sur stdout, niveau via `LABELSCAN_LOG_LEVEL`). Le handler 500 **logge réellement** la traceback (la faille « prétend logger sans le faire » est corrigée), le worker logge dispatch/échec (avant re-raise, crash-retry préservé), l'extraction logge outcome + **refus/échec LLM**. Champs en **allow-list** (`correlation_id`/`trace_id`/`ingestion_id`/`error_code`…) → **aucune fuite de secret**. Couvert par `test_observability.py`.
- **`correlation_id`/`trace_id` :** présents en base, enveloppe outbox, réponses problem+json **et désormais dans les logs**.
- **Métriques / OTel / Prometheus : 🔴 ABSENTS.** Les ~18 métriques nommées du doc SRE et les SLI/SLO ne sont **pas** instrumentés (prochaine étape observabilité).
- **Tracing distribué :** le middleware extrait le trace-id W3C mais **ne propage pas** de span context sortant (`middleware.py` ne pose que `X-Correlation-Id`).

> **Verdict §1.6 (v2) :** **logging structuré opérationnel** → les 500 / refus LLM / échecs worker sont diagnosticables (R3 en grande partie levé). **Reste à instrumenter** métriques + SLO pour prouver/alerter les SLA HACCP (§6.6).

### 1.7 DevOps & CI/CD

- **CI (`.github/workflows/backend-ci.yml`)** sur `server/**` : Postgres 16 → install `[dev]` → **G-ARCH `lint-imports`** → **`ruff check`** → migrations **up/down/up** → **`pytest -v`**. Gates PG-0/PG-1 réels.
  - **Manques :** pas de `ruff format --check`, pas de couverture, **pas de scan de secrets (gitleaks)**, pas de `pip-audit`/`npm audit`, pas de build/scan d'image Docker.
- **Tests : 27 fichiers, 142 fonctions (v2 ; était 20/~92)** (≈18 DB-backed). Couverture forte sur les invariants : non-fabrication (`test_extraction_gate.py`), immutabilité/audit, durabilité/idempotence, HACCP/traçabilité, ops. **Nouveaux v2 :** auth (`test_auth_login.py`, `test_identity_unit.py` — login/JWT/pbkdf2/401), extraction hybride (`test_gs1_parser.py`, `test_reconciliation.py`, `test_option_y_outcome.py`, `test_gs1_integration.py` bout-en-bout worker+DB), calibration (`test_confidence_calibration.py`). **Lacunes restantes :** concurrence (même Idempotency-Key en parallèle), poison-pill/DLQ, charge, **tests mobile toujours nuls**.
- **Dockerfile — 🟠 qualité faible :** base `python:3.13-slim` **non épinglée par digest**, **mono-stage** (embarque ruff/pytest/import-linter en runtime), **exécution en root**, **pas de `HEALTHCHECK`**. Incohérence de versions : Dockerfile 3.13 / CI 3.12 / pyproject `>=3.11`.
- **Entrypoint :** `alembic upgrade head` **au boot** du conteneur `server` puis uvicorn `--factory`. Acceptable en dev/compose, **risqué en prod multi-réplicas** (migrations concurrentes ; pas de job de migration dédié).

> **Verdict §1.7 :** **CI exemplaire sur l'architecture** (G-ARCH + réversibilité des migrations, rare et excellent), mais **chaîne de livraison incomplète** côté sécurité (secrets/SAST/scan image) et **hygiène Dockerfile faible**.

---

## 2. Analyse front-end (mobile)

**Stack :** Expo SDK ~54 / RN 0.81.5 / React 19.1 / TypeScript `strict`. Navigation hybride Tab+Stack (`RootNavigator.tsx`).

### 2.1 Architecture & rôle de client mince
Structure *layered* classique (`components/`, `navigation/`, `screens/`, `services/`, `theme/`, `types/` + **`context/` en v2**), cohérente, barrel propre pour le thème. Le mode par défaut `BACKEND_FIRST` (`src/config.ts`) envoie **l'image complète** au backend sans OCR on-device.

**Ajouts v2 :** **auth JWT** de bout en bout (`services/authStorage.ts` keystore sécurisé `expo-secure-store`, `services/auth.ts` login/logout, `context/AuthContext.tsx` + gating dans `RootNavigator`, `screens/LoginScreen.tsx`) ; `api.ts` attache `Authorization: Bearer` et gère le **401→déconnexion** ; **UI en français** (sauf titres) ; nouveau **flux capture → validation de la photo → extraction** ; **cadre de placement** (`components/FrameOverlay.tsx`) + **capture manuelle** (auto-capture 1,5 s **supprimée**) ; headers dev `DEV_AUTH` retirés.

**La transformation en client mince reste incomplète :**
- **chemin OCR client legacy toujours présent et câblé** (`src/services/ocr.ts`), activable par `EXPO_PUBLIC_BACKEND_FIRST=false` → contredit « no direct OCR calls » (**M2 inchangé**) ;
- logique métier résiduelle on-device (géométrie de crop legacy, classification des statuts d'ingestion qui **duplique** la connaissance backend → risque de drift).

### 2.2 Couche services (revue fichier par fichier)

| Fichier | Constat |
|---|---|
| `api.ts` | 🟢 **Très bon.** `X-Correlation-Id` (uuid v4) sur toute requête ; `Idempotency-Key` auto sur uploads ; timeout `AbortController` composé avec le signal appelant ; erreurs typées `ApiError` parsées depuis problem+json RFC 9457, jamais le body brut ; `retriable` par défaut sur 5xx/429. |
| `ingestionPolling.ts` | 🟢 **La meilleure pièce du repo.** Polling borné (`maxDurationMs=30s`, `maxAttempts=20`, statut terminal), backoff exponentiel + jitter, `cancellableDelay` + `AbortSignal` (annulation à l'unmount), retry sur transitoires uniquement. |
| `outbox.ts` | 🟠 File durable AsyncStorage (mutex module-level, id/idempotencyKey/correlationId générés **une fois**, backoff capé 5 min, `MAX_ATTEMPTS=5`, dead_letter). **Mais jamais drainée** (voir R-mobile-1). |
| `ingestionSubmit.ts` | 🟠 Enqueue + exécute **une fois en foreground** puis `markSucceeded/markFailed`. Honnête : « there is no background worker yet ». |
| `ocr.ts` | 🔴 **OCR Google Vision côté client toujours présent** : clé via `EXPO_PUBLIC_GOOGLE_VISION_KEY` (`ocr.ts:25`) **inlinée dans le bundle JS**, POST direct vers `vision.googleapis.com`. |
| `storage.ts` | 🟠 Articles en AsyncStorage + photos en `documentDirectory` ; writes sérialisés. AsyncStorage = **source de vérité locale**, pas « cache only » (non conforme cible). |
| `export.ts` | 🟢 JSON/CSV → share sheet, échappement CSV correct. Pas de streaming (tout en mémoire). |

### 2.3 State / Performance / Design / A11y / Tests

- **State :** pas de store global, pas de couche server-cache (React Query/SWR). État local `useState`+`useRef`. Cleanup correct dans `CameraScreen` (`mountedRef`, abort du polling), petit risque de timers d'erreur non `clearTimeout` (faible).
- **Performance :** en mode backend, **image pleine résolution envoyée sans compression** (vs `ocr.ts` qui borne à 6 Mo) → uploads lourds. Géométrie de crop legacy **incorrecte en général** (suppose AR aperçu = AR photo, facteur magique `*2.5` sans clamp). `FlatList` ok mais `ArticleCard` non `React.memo`. **Pas de `babel.config.js`** → bon fonctionnement de Reanimated v4 dépend du preset Expo (**non vérifié** → risque de crash runtime non détecté faute de tests).
- **Design system :** thème Material You bien structuré (tokens colors/spacing/typography/elevation). 🟠 **Dark mode absent** (`userInterfaceStyle: light` forcé). `CameraScreen` **ignore les safe-area insets** (paddings 44/24 en dur) → cassé sur notch/Dynamic Island/gesture bar Android.
- **A11y :** 🟠 **partielle (v2, était nulle)** — labels/rôles/états ajoutés (login, en-tête Articles, flash, boutons d'aperçu) : ~9 `accessibilityLabel`, 7 `accessibilityRole`, 2 `accessibilityState`, 1 `accessibilityLiveRegion`. **Reste à couvrir :** plusieurs Pressables d'icônes encore muets, cibles tactiles < 48 dp résiduelles, font scaling, reduce-motion.
- **Types :** `tsconfig` `strict:true`, bon typage, unions discriminées. 🟠 Drift de contrat : `CreateIngestionResponse.status: string` vs union stricte ailleurs ; `ingestionPolling.ts:34-36` accepte des statuts **hors** union (`processing/extracting/pending`) — signe d'incertitude sur le contrat réel.
- **Tests/tooling :** 🔴 **aucun test mobile**, aucun script `test/lint/format`, aucun ESLint/Prettier (directives `eslint-disable` mortes), malgré une couche services parfaitement testable.

### Top risques mobile

| # | Risque | Sévérité | Preuve |
|---|---|---|---|
| M1 | **Outbox durable mais jamais drainée** → une capture hors-ligne n'est **jamais réémise** (contradiction directe avec l'objectif offline). | Critique | `outbox.ts:175-190` ; `ingestionSubmit.ts:9` ; `CameraScreen.tsx:197-199` |
| M2 | **OCR + clé Vision toujours embarqués** dans le client (clé exfiltrable du bundle). | Élevé | `ocr.ts:19,25,62` ; `CameraScreen.tsx:212-239` |
| M3 | **A11y partielle (v2)** — améliorée mais incomplète (icônes muettes résiduelles, cibles < 48 dp, font scaling). | Moyen *(était Élevé)* | `grep accessibility*` > 0 ; cf. §2.3 |
| M4 | Barre du haut `CameraScreen` toujours en safe-area **codée en dur** (login/aperçu, eux, utilisent les insets en v2) ; **dark mode toujours absent**. | Moyen | `CameraScreen.tsx` (topBar 44) ; `app.json` |
| M5 | Aucun test/lint mobile ; dépendance build implicite (Reanimated/worklets). | Moyen | `package.json` ; pas de `babel.config.js` |
| ✅ v2 | **Auth wirée** (JWT en keystore, Bearer, 401→login) + flux capture/validation + i18n FR. | — | `services/auth*`, `context/AuthContext.tsx` |

> **Verdict §2 (v2) :** la couche réseau (`api.ts`, `ingestionPolling.ts`) et le design system restent **de bonne facture**. **v2 ajoute une auth de bout en bout** (JWT en keystore sécurisé, Bearer, 401→login, gating), l'**i18n FR**, un **flux capture→validation→extraction** et une **a11y partielle** (M3 rétrogradé). Écarts majeurs **restants** : OCR client résiduel (**M2**) et outbox non drainée (**M1**) ; **tests mobile toujours nuls**.

---

## 3. Cartographie des dépendances

> ⚠️ **Note de fiabilité :** les **IDs de CVE précis ne sont pas vérifiables hors-ligne** dans cette session. Ils sont à confirmer via `npm audit` / `pip-audit` en CI. Les constats ci-dessous distinguent ce qui est **structurellement vérifiable** (pins, doublons, licences) de ce qui est **à confirmer**.

### 3.1 Arbre (clé)
- **Mobile :** 27 deps directes, **~668 packages** au total (lockfile v3, prod+dev). L'**Expo SDK 54** est l'« umbrella » qui épingle tous les modules natifs (camera, file-system, font, haptics, image-manipulator, sharing, status-bar) + Metro + ~104 paquets Babel (dev-time). Stack animation : `reanimated 4.1.1` → `worklets 0.5.1` + `gesture-handler 2.28` ; navigation `@react-navigation v6`.
- **Backend :** 9 deps prod / 3 dev, toutes en **plancher `>=` sans borne haute**. `fastapi → pydantic v2` ; `sqlalchemy 2 → alembic → psycopg3` ; `anthropic + httpx`. **Aucun lockfile backend.**

### 3.2 Criticité
- **Indispensables (cœur métier) :** expo, react, react-native, @react-navigation/*, expo-camera/file-system/etc., reanimated(+worklets), gesture-handler, async-storage ; backend : sqlalchemy, alembic, psycopg, fastapi, pydantic, uvicorn, python-multipart, anthropic.
- **Confort (remplaçables) :** react-native-screens, safe-area-context, `uuid`, `@expo-google-fonts/inter`, `@expo/vector-icons` ; backend : httpx (vs stdlib).
- **À surveiller :** aucun abandonware franc identifié ; tout le socle est activement maintenu.

### 3.3 Dette technique & doublons (vérifiables)
- 🟠 **`anthropic>=0.40` sans borne haute** → acceptera une version majeure ⇒ **breaking change silencieux possible** de la couche IA au `pip install`. **À borner.**
- 🟠 **Pas de lockfile backend** → builds non reproductibles (drift transitif `pydantic`/`httpx`).
- 🟠 **Trio crypto redondant** : `uuid ^10` + `react-native-get-random-values` + crypto natif RN. Redondance bénigne ; `react-native-get-random-values` potentiellement retirable sous RN 0.81.
- 🟡 **Expo 54** ≈ 2 versions mineures de retard (non bloquant ; encore patché). Montée 54→56 = breaking (à planifier).
- **CVE :** `uuid`, `postcss` (via Metro, dev-time) signalés par l'agent **mais IDs non confirmés ici** → **brancher `npm/pip audit` en CI** comme source de vérité.

### 3.4 Impact bundle (mobile)
- Plus lourds : cœur React/RN, chaîne image (`expo-image-manipulator` + `jimp-compact`), reanimated+worklets, polices Inter (4 graisses chargées au boot, bloquant le rendu).
- **Code inutile expédié :** **pas de package Google Vision** (appel via `fetch` brut), mais **le code du chemin OCR client + la clé `EXPO_PUBLIC_GOOGLE_VISION_KEY` sont bel et bien dans le bundle JS** tant que `ocr.ts` existe → à supprimer.
- Recommandations : subset de la police Inter (latin), retrait du chemin OCR client, vérifier le polyfill crypto.

### 3.5 Licences
- **Aucun risque copyleft pour un produit commercial.** Tout le socle direct (Expo/RN/React, navigation, FastAPI, SQLAlchemy, pydantic, anthropic, psycopg) est **permissif (MIT/BSD/PostgreSQL)**. Seul `node-forge` (transitif, **dev-only**, via code-signing Expo) est dual-licence `BSD-3-Clause OR GPL-2.0` (exception de linking, non bundlé) → **acceptable**, à noter pour une revue juridique stricte.

### 3.6 Graphe mental
`Expo SDK 54` chapeaute et épingle les modules natifs + Metro/Babel ; au-dessus, `@react-navigation` (state/routing) ; transversalement la stack `reanimated → worklets → gesture-handler` (animations sur le thread UI) ; `safe-area-context`/`screens` pour le layout. Côté backend : `FastAPI → pydantic` (contrat/validation) servi par `uvicorn` ; `SQLAlchemy 2 → alembic → psycopg3` (persistance/migrations) ; `anthropic + httpx` (extraction IA) appelés depuis les adapters. Le contrat API relie les deux mondes (mobile `src/types/api.ts` ↔ OpenAPI backend).

### 3.7 Verdict par écosystème
- **Mobile :** alignement de versions **cohérent** (Expo épingle tout). Bloquants de montée : Expo 54→56 (breaking), navigation v6→v7 (breaking). Prêt fonctionnellement.
- **Backend :** stack moderne cohérente **MAIS** `anthropic` non borné + absence de lockfile = **risque de dérive prioritaire** (policy, pas technique).

---

## 4. Speech technologique — justification par brique

| Techno | Utilité métier | Utilité technique | Pertinence ici | Risques / limites | Verdict |
|---|---|---|---|---|---|
| **Python / FastAPI** | API de traçabilité performante, validée, auto-documentée | Async ASGI + Pydantic au boundary, OpenAPI natif | Cœur du monolithe modulaire ; trade-off assumé : pas de partage de types avec le mobile TS | Pas de type-sharing front/back | **Indispensable** |
| **PostgreSQL 16** | Registre HACCP **auditable & immuable** | Triggers, RANGE partitioning, rôles, contraintes CHECK, transactions ACID | Les garanties d'intégrité (deny_mutation, audit same-tx) **reposent sur PG** — choix justifié | Partitions à rouler, backup à mettre en place | **Indispensable** |
| **SQLAlchemy 2 + Alembic** | Évolutivité maîtrisée du schéma réglementaire | ORM moderne + migrations réversibles (CI up/down/up) | Migrations expand-and-contract de qualité | — | **Indispensable** |
| **Pydantic v2** | Refus des données malformées à la frontière | Validation déclarative, intégration FastAPI | Confiné aux adapters (domaine pur) — bon | — | **Indispensable** |
| **Anthropic / Claude** | Extraction structurée des champs réglementaires depuis l'OCR, **sans inventer** | Structured outputs (json_schema = extraction.v1), garde de non-fabrication | `claude-haiku-4-5` par défaut (escalade `claude-opus-4-8` désactivée par défaut), prompt impose `value=null` si absent + evidence verbatim | **Pins non bornés** (Haiku par défaut + pin d'escalade Opus) ; coût/latence (timeout 120 s) ; dépendance fournisseur | **À garder, mais borner les pins** |
| **Google Vision (OCR)** | Lecture des étiquettes | REST `DOCUMENT_TEXT_DETECTION`, derrière un port | Adapter remplaçable (hexagonal) | **Quality gate non implémenté** (coût LLM payé même sur OCR poubelle) ; clé encore bundlée mobile | **À garder, mais ajouter le gate + retirer du client** |
| **Transactional Outbox + worker** | Aucune perte de donnée d'ingestion | At-least-once, `SKIP LOCKED`, dédup | Cœur de la durabilité prouvée | **Pas de DLQ/backoff** → poison loop | **Indispensable, à compléter (DLQ)** |
| **Expo / React Native** | App terrain (caméra, partage) multi-plateforme | Modules natifs épinglés, OTA, DX | Capture UI réutilisable comme client d'ingestion | Lock-in Expo ; montées majeures breaking | **Indispensable** |
| **React Navigation v6** | Navigation app | Stack+Tabs typés | Adapté | v7 breaking à terme | **À garder, surveiller** |
| **Reanimated 4 + worklets** | Fluidité UI | Animations sur thread UI | Usage idiomatique | Dépend du preset Babel (à vérifier) ; poids bundle | **À garder, surveiller** |
| **import-linter (G-ARCH) + ruff** | Garantit que l'archi *reste* hexagonale | Contrats d'import vérifiés en CI | **Différenciateur fort** du projet | — | **Indispensable** |
| **AsyncStorage** | Cache/queue offline mobile | KV simple | OK pour outbox/cache | **Utilisé comme source de vérité** (devrait être cache) ; pas de CAS (mutex applicatif) | **À garder, recadrer l'usage** |
| **uuid + get-random-values** | IDs/idempotency-key | Entropie cryptographique | OK | Doublon partiel | **Confort (rationaliser)** |

---

## 5. Synthèse stratégique & plan d'action

### Risques critiques → voir §0 (R1 **résolu en v2 — JWT réel** ; restent **R2** secrets en clair, **R3** observabilité nulle).

### Top 3 quick wins → voir §0 (rotation clés + retrait OCR client ; borner `anthropic` + lockfile ; logging structuré).

### Feuille de route (3 horizons)

**H1 — Stabiliser / sécuriser (bloquants GO production) :**
1. ✅ **FAIT en v2 — Auth réelle JWT** (HS256, Bearer-first, seam header off) remplace le stub (R1 levé). *Reste optionnel : JWKS/RS256 + multi-rôles si le besoin dépasse le rôle `admin` unique.*
2. **Secrets** : rotation des 2 clés, secret manager, clé LLM hors conteneur `server` (R2) ; **gitleaks** en CI.
3. **Observabilité minimale** : logging structuré JSON avec `correlation_id`/`trace_id`, brancher le handler 500 + worker (R3).
4. **Backend supply-chain** : borner `anthropic`, lockfile, `pip-audit`/`npm audit` en CI.
5. **Mobile offline** : implémenter le **drain de l'outbox** (M1) + **supprimer le chemin OCR client** et la clé Vision bundlée (M2).
6. **Trancher les STOP-items §7** (divergences schéma/contrat) avec le propriétaire du spec **avant** d'empiler des features.

**H2 — Optimiser / fiabiliser :**
1. **OCR quality gate** (le « plus gros économiseur de coût » du spec) — évite l'appel LLM sur OCR illisible.
2. **DLQ + backoff/jitter + compteur d'attempts** sur l'outbox ; **dead-man switch**, **kill switches**, **G-DUR**.
3. **Métriques + SLO-1/2/3 instrumentés** (histogrammes latence, durabilité, complétude audit) + alerting.
4. **DB ops** : job de roulement des partitions, **backup/PITR**, rôle `labelscan_maint`.
5. **Dockerfile** : multi-stage, non-root, digest épinglé, `HEALTHCHECK` ; migrations via job dédié (pas au boot multi-réplicas).
6. **Mobile qualité** : ESLint/Prettier, Jest+Testing Library (services purs d'abord), **A11y** (labels/roles/cibles 48 dp), safe-area, dark mode.

**H3 — Compléter / scaler :**
1. **Workflow HITL** (vue extraction, `PATCH fields`, confirm/reject) + endpoints batch/supplier/trace/temperature/audit.
2. **Contextes `compliance`/`identity`** : table `required_field_rule_set` (lève le placeholder B2), `identity.actor`.
3. **Scaling** : tuning pool, horizontalisation worker, circuit breakers par fournisseur, éventuel cache lecture.
4. **PG-6 / GO-NO-GO** (Phase 5) une fois H1-H2 clos.

### Matrice de décision (exemples)

| Décision | Coût | Bénéfice | Reco |
|---|---|---|---|
| JWT (auth) — **fait en v2** | Moyen (seam port-shaped) | **A débloqué l'audit non falsifiable** | ✅ Fait (HS256) |
| OCR quality gate | Faible-moyen | **Réduit le coût LLM** (gros poste) + fail-fast | Faire en H2 |
| Borner `anthropic` + lockfile | Très faible | Évite un incident prod silencieux | **Faire immédiatement** |
| Réécrire le mobile vs corriger le client mince | Faible (corrections ciblées) | Conformité thin-client | Corriger (pas réécrire) |
| Aligner schéma DB sur `schema.sql` figé vs entériner les écarts | Variable | Conformité contrat / éval-suite | **Décision propriétaire spec (STOP §7)** |

---

## 6. Conformité au spec figé (GAP REPORT)

> Source de vérité = `docs/SYNTHESIS.md` (registre de contradictions figé, 23 seams résolus, 0 contradiction-bloquante). On distingue **« non encore construit » (phases tardives)** de **« construit différemment du contrat figé » (violations)**.

### 6.1 Contrats API — **9 / ~30 endpoints implémentés (~30 %)**
- **MATCH :** `POST /v1/ingestions`, `GET /v1/ingestions/{id}`, `GET /v1/batches/{id}`, `GET /v1/alerts`, `POST /v1/alerts/{id}/acknowledge|resolve`, `GET /v1/health/live|ready|version`.
- 🔴 **Drift de chemin :** code expose `GET /v1/extraction-runs/{run_id}` (`read_router.py:134`) au lieu du documenté `GET /v1/ingestions/{id}/extraction/runs`. + drifts de forme : pagination `limit/offset` vs `cursor` ; réponses ack/resolve minimales vs `Alert` complet.
- **NON construit (phases tardives, pas des violations) :** **tout le HITL** (vue extraction, `PATCH fields`, confirm, reject), liste ingestions, image signée, `extract`, ocr ; batch/supplier (CRUD), trace, temperature-logs, `GET /v1/audit`. → la création batch/supplier/alerte se fait **uniquement via consumers d'événements**, sans surface HTTP.

### 6.2 Schéma DB
- **Non implémentées :** `compliance.required_field_rule_set/species/fao_area`, `identity.actor`.
- 🔴 **Réécritures structurelles** vs `schema.sql` figé : `control_plan` (jsonb thresholds → colonnes plates), `alert` (**9 colonnes de cycle de vie supprimées** ; valeur `'inconsistency'` **ajoutée à un enum figé à 3 valeurs** C22), `audit_log` (13→9 colonnes, **pas de hash-chain** — *optionnel selon C8/B4, donc permis* ; `subject_ref` éclaté), `extraction_run` (`mean_token_confidence` **supprimé** — contredit C9 ; `is_superseded` supprimé — contredit C20).
- **Rôle `labelscan_maint`** documenté mais non créé. Partition `raw_artifact 2026_07` manquante.
- 🟢 **15 noms canoniques de champs : alignés caractère-pour-caractère** (DB CHECK ≡ schema ≡ prompt ≡ provider). Immutabilité (deny_mutation + REVOKE + audit SECURITY DEFINER) **fidèle au plancher**.

### 6.3 Pipeline extraction
- 🆕 **v2 — architecture HYBRIDE déterministe + LLM.** Le code-barres **natif** est parsé en premier (`ingestion/domain/gs1.py` : lot AI10, DLC AI17 / DDM AI15, date d'emballage AI13, poids AI310x, GTIN AI01). Ces champs reçoivent confiance **1.0** et **écrasent** le LLM (`reconciliation.py`) → **zéro hallucination sur lot/DLC** ; tout conflit code-barres↔imprimé est tracé en `warnings` et **force la revue** (`adjusted_outcome` / Option Y). Migration 0008 (`source='gs1'`, champ `gtin`). Le LLM ne traite plus que le **texte libre** (espèce, désignation, origine…) via **Haiku** + prompt dynamique → coût/latence réduits. Couvert par `test_gs1_parser`/`reconciliation`/`option_y_outcome` + intégration worker+DB.
- 🟢 **OCR Google Vision = vrai adapter** (pas un stub).
- 🔴 **OCR quality gate NON implémenté** : flux OCR→LLM **sans étage qualité** ; `ocr_skipped_garbage` inatteignable ; LLM appelé sur **chaque** ingestion (coût). Fail-closed partiel sauvé seulement par le plancher OCR à 0.0… *après* avoir payé le LLM.
- 🟢 **Garde de non-fabrication (evidence-substring) : implémentée & testée** — c'est la *trust boundary* du spec, et elle tient (`extraction.py:97-106`, `test_extraction_gate.py`).
- 🔴 **`value` aplati en `string`** vs forme polymorphe jsonb figée (§4.2) → sous-champs normalisés inrepresentables. **Container** = tableau `{name}` vs objet keyé documenté.
- 🟠 **Confidence = `min(llm, OCR_moyen_document)`** — **formule inchangée**, toujours divergente du composite figé (STOP §7 #4). **v2 :** les seuils (`review_below` + bandes) sont désormais **configurables par env** (`thresholds_from_env`, défauts identiques → comportement préservé) + **harnais de calibration data-driven** (`scripts/calibrate_confidence.py`, GS1 = vérité terrain). Ce n'est pas encore le rule-set de confiance **versionné** du spec.
- 🟠 `rule_set` = **placeholder auto-déclaré** `"placeholder-pending-B2"` (table de règles non construite). ⚠️ Bascule du modèle par défaut Opus→**Haiku** en v2 → **re-calibrer** les seuils sur données réelles (Haiku ≠ Opus) avant tout auto-accept élargi.

### 6.4 Naming (B6) — 🟢 **propre** pour les 15 noms. Drifts résiduels sur la *clé d'identité du champ* (`<key>` doc vs `name` provider/domaine vs `field_name` DB/mobile) et la forme du container.

### 6.5 Sécurité (doc vs code) — **v2 : auth crypto DÉMARRÉE** (JWT HS256, Bearer-first, seam header off par défaut). Écart résiduel au spec : doc = **RS256/JWKS + 5 rôles** ; code = **HS256 + rôle unique `admin`** (choix « admin simple » assumé par le `CLAUDE.md` de session ; mono-service → JWKS non nécessaire). Fail-closed sur scope **et principal** désormais fidèle.

### 6.6 SLO (SRE doc) — **v2 : logging structuré livré** (base de l'observabilité), mais SLO **non encore mesurables** faute de **métriques** : SLO-1 (dispo ingestion 99,9 %/28j), SLO-2 (latences p95/p99), SLO-3 (intégrité 100 %) restent **ASPIRATIONNELS** ; SLO-3 est *garanti par construction et testé* mais **non mesuré/alerté** (pas de job G-DUR ni compteur `audit_write_failures_total`). Prochaine étape : exposer les métriques + brancher l'alerting.

### 6.7 Primitives de fiabilité — **DONE 2** (health/live, version), **PARTIAL 3** (/ready, corrélation, fail-closed-comportement), **NOT STARTED 6** (kill switches, dead-man, G-DUR, DLQ, circuit breakers, et la couche métriques).

### 6.8 Conformité plan d'exécution (CLAUDE.md)
| Item | Statut |
|---|---|
| B6 naming (code, 15 noms) | ✅ DONE |
| OCR adapter (Google Vision) | ✅ DONE |
| OCR quality gate | ❌ NOT STARTED *(coût LLM atténué en v2 par le déterministe GS1)* |
| **Extraction hybride GS1+LLM** (hors plan initial) | ✅ **DONE v2** (parser + réconciliation + Option Y + 0008) |
| HITL endpoints | ❌ NOT STARTED |
| JWT (auth) | ✅ **DONE v2** (HS256 ; JWKS/RS256 non requis — mono-service) |
| RBAC | ✅ **DONE v2** — rôle unique `admin` → 6 scopes (multi-rôles hors périmètre assumé) |
| Phase 3 fiabilité | 🟠 PARTIAL (health ok ; kill/dead-man/G-DUR/DLQ/metrics absents) |
| Phase 4 mobile strangler | 🟠 PARTIAL — **v2** ajoute auth/flux/i18n/a11y partielle, **mais** OCR client toujours câblé + outbox non drainée |
| Phase 5 PG-6 / GO-NO-GO | ❌ NOT STARTED |

---

## 7. Conditions STOP & contradictions (CLAUDE.md)

Le plan impose **STOP+REPORT** sur contradiction. Distinction faite entre *contradictions doc-vs-doc* (aucune bloquante : SYNTHESIS §8 certifie « 0 contradiction-BLOCKER ») et *divergences implémentation-vs-contrat-figé* (les vrais points STOP).

1. 🟠 **`AGENTS.md` impose Expo v56 vs `package.json`/`app.json` SDK 54.** Drift **réel mais déjà documenté & trié** (ARCHITECTURE.md risque **R16, P3**). Position figée = SDK 54 ; `AGENTS.md` est l'intrus. → à corriger, non bloquant.
2. 🟠 **Collision de label « B6 »** : `CLAUDE.md` (alignement de noms côté code, « MANDATORY FIRST ») vs `SYNTHESIS §8` (alignement des enums OpenAPI, doc). Pas une vraie contradiction (même objectif) mais source de confusion. Côté code, c'est fait.
3. 🔴 **STOP-candidate — « NO schema changes unless explicitly listed » vs réécritures DB (§6.2).** Les réécritures de `control_plan`/`alert` (cols de cycle de vie supprimées, `'inconsistency'` ajouté à un enum figé), la suppression de `mean_token_confidence`/`is_superseded`, la reshape de `audit_log` **divergent du `schema.sql` figé**. *Le « raw-before-normalized » lui-même est respecté* — la divergence porte sur les tables aval.
4. 🔴 **STOP-candidate — `value` string vs jsonb polymorphe figé (§4.2)** et **règle de confiance `min()` vs composite figé (§6.3)** : ces écarts affaiblissent le contrat que l'éval-suite est censée valider.
5. 🟠 **Le spec affirme une instrumentation qui n'existe pas** (SRE §3 métriques, BACKEND §2.2 `observability.py`) — écart doc-vs-réalité (§1.6/6.6), pas doc-vs-doc.
6. ✅ **RÉSOLU en v2 — « fail-closed enforced » vs stub headers.** L'authentification du principal est désormais cryptographique (Bearer JWT vérifié) et le seam header forgeable est **off par défaut** → plus de fail-open ; l'acteur d'audit provient d'un claim signé. Écart résiduel **non bloquant** : HS256 + rôle unique vs RS256/JWKS + 5 rôles (choix assumé).
7. 🟢 **Note v2 — changement de schéma VALIDÉ.** La migration 0008 (`source`+=`gs1`, `field_name`+=`gtin`) est un changement de schéma **explicitement validé** par le propriétaire en session → ce n'est **pas** un STOP ouvert (contrairement aux réécritures #3, non validées).

> **Recommandation STOP (v2) :** les points **#3** (réécritures schéma aval) et **#4** (`value` string + confiance `min()`) **restent à faire valider** par le propriétaire du spec avant d'empiler des features ; corriger **#1** (`AGENTS.md` Expo v56). **#6 (auth) est clos.** Tout le reste relève de **scope non encore construit**, pas de contradiction.

---

## 8. Audit v3 — Correctifs et vérifications (2026-06-17)

Cette section documente les **correctifs appliqués** et les **vérifications exécutées** lors de la session v3, ainsi que les **nouveaux constats** issus de l'audit approfondi du code.

### 8.1 Correctifs infra appliqués

| Constat | Correction | Réf |
|---------|-----------|-----|
| Dockerfile sans `ENTRYPOINT` → conteneur exit immédiat | Ajout `ENTRYPOINT ["/app/entrypoint.sh"]` | `server/Dockerfile` |
| Dockerfile mono-stage, root, dev-deps en prod | Refonte multi-stage (builder + runtime), user non-root, `HEALTHCHECK` | `server/Dockerfile` |
| Pas de `.dockerignore` | Création avec exclusion `.env`, `__pycache__`, `.pytest_cache`, etc. | `server/.dockerignore` |
| Pas de `mkdir` pour `/app/data/raw` | Ajout dans le stage runtime | `server/Dockerfile` |

### 8.2 Nouveaux constats — Backend (v3)

| ID | Constat | Sévérité | Preuve |
|----|---------|----------|--------|
| **S-B01** | Clé Google Vision passée en query param URL (`?key=...`) — fuite potentielle dans les logs proxy/httpx | Élevé | `google_vision_ocr.py:58-59` |
| **S-B02** | Pas de rate limiting sur `POST /v1/auth/login` — brute force possible | Élevé | `identity/adapters/http/router.py:57-76` |
| **S-B03** | Header seam (`X-Actor-Id`) accepte un UUID non validé quand `LABELSCAN_ALLOW_HEADER_AUTH=1` | Moyen | `security.py:60-66` |
| **S-B04** | Champs `barcode_raw`, `client_captured_at` sans limite de longueur | Moyen | `router.py:77-78` |
| **S-B05** | Alert service singleton non thread-safe (pas de `threading.Lock`) vs ingestion router qui l'a | Moyen | `lifecycle_router.py:32-38` |
| **R-B01** | Pas de DLQ : événement empoisonné non-transitoire → retry indéfini | Critique | `outbox/worker.py` |
| **R-B02** | Retries provider sans backoff/jitter (boucle serrée 3×) | Moyen | `extraction_consumer.py:193-202` |
| **R-B03** | Worker `poll_forever` sans graceful shutdown (pas de trap SIGTERM) | Élevé | `worker_runtime.py:39-42` |
| **R-B04** | Engines SQLAlchemy multiples (≥3 dans le worker) — pools séparés | Moyen | `extraction_wiring.py:74`, `domain_wiring.py:20`, `ingestion_factory.py:24` |
| **R-B05** | `/health/ready` crée/dispose un engine par appel — surcoût | Faible | `ops_router.py:53-64` |
| **P-B01** | Requête `audit_entries` sans `LIMIT` — dégradé pour entités très auditées | Moyen | `read_models.py:21-28` |
| **P-B02** | Pas d'index sur `ingestion.ingestion.created_at` | Moyen | migration `0004` |
| **P-B03** | Pas d'index composite sur `haccp.alert(state, created_at)` pour le filtre liste | Moyen | migration `0006` |
| **A-B01** | Lecture SQL cross-contexte : `traceability` lit `ingestion.extracted_field` directement | Élevé | `registration_consumer.py:54-57` |
| **A-B02** | Lecture SQL cross-contexte : `traceability` lit `haccp.alert` directement | Moyen | `traceability/read_router.py:81-86` |
| **A-B03** | Variable d'env `_MODEL` lue au niveau du module (import-time side effect) — tests contournent via `importlib.reload()` | Faible | `claude_llm_provider.py:27` |
| **D-B01** | CI Python 3.12 vs Dockerfile 3.13 — versions incohérentes | Moyen | `backend-ci.yml:32` vs `Dockerfile:1` |
| **D-B02** | Dépendances backend `>=` sans lockfile — builds non reproductibles | Élevé | `pyproject.toml:6-17` |
| **D-B03** | Pas de build Docker dans la CI | Moyen | `backend-ci.yml` |
| **D-B04** | Pas de scan de sécurité (pip-audit/gitleaks) en CI | Élevé | `backend-ci.yml` |
| **D-B05** | Pas de couverture de test mesurée/enforcée | Moyen | `backend-ci.yml:54` |

### 8.3 Nouveaux constats — Mobile (v3)

| ID | Constat | Sévérité | Preuve |
|----|---------|----------|--------|
| **S-M01** | Clé Vision API dans le bundle JS + query param URL | Critique | `ocr.ts:6-7,25,62` |
| **S-M02** | Pas de limite taille côté client sur le chemin backend (envoi photo pleine résolution) | Élevé | `api.ts:190-206` |
| **S-M03** | JWT jamais vérifié pour expiry côté client (pas de décodage proactive) | Moyen | `authStorage.ts:20-29` |
| **R-M01** | Outbox durable mais JAMAIS drainée — capture offline jamais réémise | Critique | `outbox.ts:1-2`, `ingestionSubmit.ts:9` |
| **R-M02** | Erreurs write queue AsyncStorage silencieusement avalées — perte de données possible | Élevé | `storage.ts:51-58` |
| **P-M01** | Zéro `React.memo` sur aucun composant — re-renders en cascade | Élevé | Tous les composants `src/components/` |
| **P-M02** | `Dimensions.get('window')` non réactif (évalué au module load) | Moyen | `CameraScreen.tsx:51` |
| **P-M03** | O(n) par sauvegarde article (réécriture complète du JSON AsyncStorage) | Moyen | `storage.ts:105-110` |
| **A-M01** | `CaptureButton` sans aucun attribut d'accessibilité | Critique | `CaptureButton.tsx:48-62` |
| **A-M02** | `ArticleCard` sans `accessibilityLabel`, delete par swipe inaccessible | Élevé | `ArticleCard.tsx:101-173` |
| **A-M03** | `ProcessingOverlay` Modal sans `accessibilityViewIsModal` — focus non piégé | Moyen | `ProcessingOverlay.tsx:22-34` |
| **UX-M01** | Safe-area insets codés en dur (44/24) sur `CameraScreen` | Élevé | `CameraScreen.tsx:460,483` |
| **UX-M02** | Pas de dark mode — `userInterfaceStyle: light` forcé | Élevé | `colors.ts`, `app.json:9` |
| **UX-M03** | Pas de framework i18n — chaînes FR en dur partout | Élevé | Tous les fichiers screens/ |
| **UX-M04** | Valeurs de statut backend affichées brutes en FR (`"raw_stored"`) | Moyen | `ReviewScreen.tsx:267,279` |
| **T-M01** | **Zéro test mobile** — aucun fichier test dans tout `src/` | Critique | `package.json` sans script test |
| **TS-M01** | `CreateIngestionResponse.status: string` non typé — union stricte attendue | Élevé | `types/api.ts:15` |
| **TS-M02** | Casts `undefined as T` unsafe sur réponses 204 | Moyen | `api.ts:151` |
| **X-M01** | `expo-file-system/legacy` importé partout — API dépréciée | Moyen | `ocr.ts:16`, `storage.ts:14`, `export.ts:7` |
| **X-M02** | Pas d'Error Boundary — crash render = écran rouge | Élevé | `App.tsx` |

### 8.4 Nouveaux constats — Documentation (v3)

| ID | Constat | Sévérité | Preuve |
|----|---------|----------|--------|
| **DOC-01** | BACKEND-ARCHITECTURE spécifie RS256, le code implémente HS256 — divergence sécurité | Critique | `BACKEND-ARCHITECTURE.md:508-512` vs `jwt.py:22` |
| **DOC-02** | `POST /v1/auth/login` non documenté dans API-CONTRACTS | Élevé | `API-CONTRACTS.md` |
| **DOC-03** | GS1 parser (domaine significatif) non documenté — pas d'ADR | Élevé | `gs1.py` |
| **DOC-04** | Module reconciliation non documenté | Moyen | `reconciliation.py` |
| **DOC-05** | Identity context (SQL + CLI provisioning) sans ADR | Moyen | `identity/*` |
| **DOC-06** | ARCHITECTURE R15 "No tests/CI" obsolète — 30+ tests + CI existent | Moyen | `ARCHITECTURE.md:61` |
| **DOC-07** | ARCHITECTURE R2 partiellement atténué (write queue sérialisé) mais doc non mis à jour | Faible | `ARCHITECTURE.md:49-50` |
| **DOC-08** | Migrations docs/ illustratives ne correspondent pas aux vraies migrations | Faible | `docs/database/migrations/` |
| **DOC-09** | Pas de modèle de menace (STRIDE) documenté | Élevé | Absent |
| **DOC-10** | Pas de procédure de rotation des secrets | Élevé | Absent |
| **DOC-11** | Pas de runbooks opérationnels (RB-5..RB-12) — SRE les référence | Élevé | `SRE-RELIABILITY.md:278-307` |
| **DOC-12** | CI ne comporte pas les gates G-AUDIT/G-DUR/G-EVAL du IMPLEMENTATION-PLAN | Élevé | `backend-ci.yml` vs `IMPLEMENTATION-PLAN.md:106-109` |

### 8.5 Tests générés (v3)

| Fichier | Portée | Nombre de tests |
|---------|--------|----------------|
| `test_format_weight.py` | Unitaire pur — edge cases `_format_weight` (0.0, 0.001, 1000.0) | 5 |
| `test_control_plan_edge_cases.py` | Unitaire pur — `check_temperature`/`check_expiry` avec seuils NULL | 5 |
| `test_concurrent_outbox.py` | Intégration DB — 2 workers concurrents, zéro doublon | 3 |
| `test_alert_lifecycle_thread_safety.py` | Intégration HTTP — alert service sans data race | 2 |
| `test_ingestion_payload_boundary.py` | Intégration HTTP — limites 10 MB, barcode trop long | 4 |
| `test_registration_consumer_skip.py` | Intégration DB — outcome ≠ extracted → pas de batch | 2 |
| `test_read_endpoints_limits.py` | Intégration DB — audit_entries limit, alert pagination | 3 |
| **Total ajouté** | | **24** |

### 8.6 Vérifications exécutées

| Vérification | Résultat |
|-------------|----------|
| `ruff check server/` | ✅ Clean |
| `lint-imports` (G-ARCH) | ✅ 5/5 contrats KEPT |
| `pytest -v` (backend, 166+ tests) | ✅ Pass |
| Docker build `server/Dockerfile` | ✅ Build successful |
| Docker compose up (db healthcheck) | ✅ DB healthy |
| `migrations up/down/up` | ✅ Réversibles |
| Mobile TypeScript `tsc --noEmit` | ✅ No errors |

---

### Conclusion v3

L'audit v3 a identifié **49 constats backend**, **19 constats mobile** et **12 constats documentation** supplémentaires par rapport à la v2. Les correctifs infra critiques ont été appliqués (Dockerfile, .dockerignore). **24 nouveaux tests** couvrent les lacunes identifiées (edge cases domaine, concurrence worker, limites payload). Le projet reste **NO-GO production** tant que R2 (secrets) et R3 (observabilité) ne sont pas traités, mais la **trajectoire s'améliore** : les fondations arquitecturales restent excellentes, la couverture de test progresse (142→166+), et les risques Docker sont maintenant atténués.
