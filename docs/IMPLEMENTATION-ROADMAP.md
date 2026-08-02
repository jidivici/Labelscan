# LabelScan — Plan d'implémentation (état au 3 juillet 2026)

**Objectif :** passer de l'état actuel (cœur métier complet, testé, mono-site, mono-compte)
à un produit déployable chez un grand compte, en répondant aux exigences de l'application :
**traçabilité HACCP nominative, intégrité auditable, latence perçue minimale, résilience
offline, coût IA maîtrisé.**

**Principe d'ordonnancement :** chaque phase (1) débloque la suivante ou un jalon commercial,
(2) s'appuie sur un socle qui EXISTE déjà dans le code (vérifié), (3) garde les suites de
tests vertes en continu. Les décisions structurantes (isolation tenant, hébergeur, MDM) sont
prises en spike AVANT d'écrire les migrations qu'elles conditionnent.

---

## Phase 0 — Actions immédiates (cette semaine, ~2 jours, aucun risque)

| # | Action | Pourquoi maintenant | Socle existant |
|---|--------|--------------------|----------------|
| 0.1 | **Rotation de la clé Google Vision** (Cloud Console) — manuelle | La clé purgée du bundle reste extractible des builds passés | P0 code déjà livré |
| 0.2 | **Déployer un staging prod-like** (1 VM UE, docker compose actuel) + série de mesures `extraction_timing` / `wait_ms` | Toutes les décisions latence/scale en dépendent ; l'egress Docker-macOS fausse les chiffres actuels | Logs structurés + instrumentation déjà en place |
| 0.3 | **Session app lancée** : valider la cascade visuelle (CascadeReveal, check animé) ET la checklist device de la refonte workflow v1 (capture enchaînée, cartes « En cours », visionneuse pinch/pan/double-tap, carte cover arrondie §6.3 — code livré le 5 juillet, voir `CLAUDE.md` §🔁), tester le long-poll réel sur device | Dernier lot de travail « aveugle » à valider à l'œil ; §6.3 attend ça depuis le 21 juin | Tout le code est prêt, seul le rendu reste à juger |

**Jalon : démo fluide sur device réel + chiffres de latence honnêtes.**

---

## Phase 1 — Identité nominative + RBAC (~2 semaines) — LE bloquant n°1

> Exigence servie : **l'audit HACCP doit nommer QUI a scanné/validé/confirmé.** Aujourd'hui
> tous les acteurs sont le même admin. C'est à la fois l'exigence réglementaire et la
> première question d'un acheteur grand compte.

Le socle existe déjà — c'est une **extension**, pas une construction :
`identity.app_user` (migration 0007, hash, login JWT), `actor_id` porté par le token jusqu'à
l'audit trail non contournable, scopes déjà vérifiés par `require_scope` sur chaque endpoint.

1. **Migration 0014** : élargir `ck_app_user_role` → `('admin','operator')`
   + colonnes `display_name`, `active`, `created_by`. (Pattern exact de la 0011 : élargir un
   CHECK sans casser l'existant.)
2. **Mapping rôle → scopes** (à l'émission du JWT, dans `login.py`) :
   - `operator` : `ingestion:write ingestion:read extraction:review` (scan + revue + confirm) ;
   - `admin` : tous les scopes métier + gestion des utilisateurs.
   Aucune modification des endpoints : `require_scope` fait déjà le travail.
3. **Endpoints de gestion** (`identity/adapters/http`) : `POST/GET /v1/users`,
   `PATCH /v1/users/{id}` (désactivation, reset mot de passe), scope `identity:admin`,
   audités. Provisioning simple maintenant, SCIM/SSO en phase 5.
4. **Mobile** : l'écran de login existe — afficher l'utilisateur courant (déjà fait via
   `useAuth`), expiration/refresh du token (aujourd'hui : expiration sèche → re-login),
   verrouillage PIN rapide pour device partagé en criée (re-login opérateur en 4 chiffres).
5. **Tests** : chaque rôle sur chaque endpoint clé (matrice), audit `actor_id` distinct
   vérifié sur scan → override → confirm.

**Spike parallèle (2 jours, décision phase 5) :** isolation multi-tenant — prototype RLS
`tenant_id` sur une table clone vs schéma-par-tenant. Trancher MAINTENANT pour que toute
migration écrite après la 0014 soit compatible avec le choix.

**Jalon : chaque geste de traçabilité est nominatif — condition du pilote payant.**

---

## Phase 2 — Industrialisation pilote (~3 semaines, parallélisable avec la phase 1)

> Exigences servies : **disponibilité, durabilité des preuves (photos = pièces d'audit),
> exploitabilité.**

1. **Infra UE gérée** : Postgres managé + PITR/backups testés (restauration réelle, pas
   juste des dumps) ; **stockage objet S3-compatible pour le raw store** — le port `RawStore`
   existe, c'est un adaptateur `S3RawStore` à écrire (put/exists/read, même contrat
   content-addressed) ; secrets manager (fin du `.env` monté) ; Terraform minimal ;
   environnements staging/prod.
2. **Observabilité** : agrégation des logs JSON existants (Loki ou Datadog) + dashboards sur
   les métriques DÉJÀ émises (`extraction_timing`, `interim_persisted`, escalade, cache
   hit-rate, DLQ) + alerting (profondeur DLQ > 0, worker health, taux `extraction_failed`,
   latence p95). Le gros du travail d'instrumentation est déjà fait — il manque la stack.
3. **CI/CD déploiement** : build image, `alembic upgrade` automatique avec gate de rollback,
   déploiement rolling. La CI de test existe.
4. **Test de charge** (staging, 50 scans/min en pointe) → décide : nombre de replicas worker,
   et si le long-poll sync doit passer en LISTEN/NOTIFY (Tier 2) — seuil ~30 devices
   simultanés/instance documenté dans read_router.
5. **Re-soumission automatique des `extraction_failed`** au retour du provider (job qui
   rejoue via l'outbox — append-only le permet nativement) + Batches API pour les backfills
   (−50 % de coût).

**Jalon : « c'est en production » opposable — SLO mesurés, backups restaurés une fois.**

---

## Phase 3 — Qualité IA opposable (~2 semaines, parallèle, forte valeur commerciale)

> Exigence servie : **précision d'extraction prouvable, champ par champ** — l'argument
> qui transforme la démo en dossier.

1. **Golden set réel** : 200-500 étiquettes annotées (multi-fournisseurs, multi-langues,
   cas dégradés). C'est le seul poste qui demande du travail métier manuel — le commencer
   tôt, il gate le reste.
2. **Éval exécutoire en CI** : les seuils SC1-SC10 (PROMPT-CONTRACT) existent sur le papier ;
   les brancher sur le golden set, bloquer tout changement de prompt/modèle qui régresse.
3. **Décisions coût sur données** : `TEXT_DETECTION` (flag `LABELSCAN_OCR_FEATURE` prêt) et
   image ≤1280 px — GO/NO-GO sur l'éval, pas à l'intuition.
4. **Monitoring qualité prod** : taux de `needs_review`, taux d'override humain par champ
   (= taux d'erreur réel terrain), dérive hebdo. Exposer ces chiffres dans le dashboard
   phase 2 — et dans le dossier commercial.

**Jalon : « notre précision mesurée est de X % par champ » — différenciant en avant-vente.**

---

## Phase 4 — Distribution mobile durcie (~2 semaines)

> Exigences servies : **déploiement contrôlé sur flotte, diagnostic terrain, scale local.**

1. **Builds EAS signés** + canaux expo-updates (staging/prod) + distribution **MDM**
   (Intune/Workspace ONE — décision avec le client pilote ; les stores publics sont le repli).
2. **Sentry** (crash + erreurs) + télémétrie latence terrain (le `latencyLog` existe —
   le faire remonter).
3. **`SqliteArticleStore`** : brancher expo-sqlite derrière le port `ArticleStore` (prêt,
   seam `setArticleStore()`) + FTS5 pour l'omni-search + migration one-shot depuis
   AsyncStorage (le plan détaillé Fix 7.2 étape 2 existe).
4. i18n si le pilote a des sites non francophones (sinon différer).

**Jalon : flotte de devices administrable, incidents terrain visibles.**

---

## Phase 5 — Contrat groupe : multi-tenant, SSO, intégration SI (~6-10 semaines)

> Exigences servies : **multi-sites cloisonné, SSO d'entreprise, la donnée rejoint l'ERP.**

1. **Multi-tenant** selon le spike de phase 1 (recommandation a priori : `tenant_id` + RLS
   Postgres — le moins invasif vu les triggers/append-only existants) : modèle
   organisation → sites → utilisateurs, chaque ingestion rattachée à un site, agrégations
   groupe pour l'administrateur national.
2. **SSO OIDC** (Entra ID en premier) à côté du login local — la couche JWT/scopes de la
   phase 1 reste, seul l'émetteur change ; provisioning SCIM si exigé.
3. **API d'intégration** : compléter l'OpenAPI, webhooks (arrivage confirmé, alerte,
   non-conformité) + exports batch (CSV/JSON, SFTP au pire) + export réglementaire DDPP.
   Connecteurs spécifiques (SAP QM…) = prestation par contrat, pas produit.
4. **Dossier sécurité/conformité** (à DÉMARRER dès la phase 2, long en délai) : pentest
   tiers + remédiation, DPA signable + DPA sous-traitants (Anthropic, Google Vision),
   questionnaire sécurité pré-rempli (CAIQ/SIG-Lite), rétention 5 ans + réversibilité.

**Jalon : déploiement multi-sites contractualisable avec SLA.**

---

## Vue d'ensemble

```
Semaine :   1  2  3  4  5  6  7  8  9  10 11 12 13 14 15 16
Phase 0    ██
Phase 1       ████████ (+spike RLS)
Phase 2       ████████████ (parallèle)
Phase 3          ████████ (parallèle, golden set démarre S1)
Phase 4                   ████████
Phase 5                            ████████████████████
Dossier sécu     ░░░░░░░░░░░░░░░░░░░░░░░░ (fil rouge, prestataires)
```

- **~4-6 semaines** → pilote payant mono-site possible (fin phases 1-3).
- **~3-5 mois** → contrat groupe (fin phase 5), cohérent avec PROD-READINESS.md.
- Charge : 1-2 devs seniors + prestataires ponctuels (pentest, juridique) + travail métier
  (annotation golden set — commencer semaine 1).

## Règles de conduite (inchangées, elles ont fait leurs preuves)

- Append-only / audit non contournable / gate no-fabrication : **jamais relâchés** par une
  fonctionnalité — c'est l'argument de vente.
- Toute décision coût/latence IA passe par l'éval (phase 3), jamais par l'intuition.
- Suites vertes en continu : backend (`run_local_proofs.sh`, PG éphémère) + mobile
  (typecheck + jest) avant chaque livraison ; import-linter 5/5.
- Une migration = compatible avec la décision d'isolation tenant prise au spike phase 1.
