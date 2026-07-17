# Audit qualité — LabelScan v1.1

**Date :** 6 juillet 2026.
**Périmètre :** tout le dépôt — mobile (`src/`, 9 250 lignes TS/TSX), backend (`server/`,
92 fichiers Python), base de données, docs, config.
**Objectif :** mesurer l'écart avec un produit SaaS prêt pour la production et prioriser.
**Preuves fraîches (exécutées ce jour)** : `tsc --noEmit` 0 erreur ; jest **212/212** (22
suites) ; pytest **242 passed + 1 skipped** ; import-linter **5/5 contrats KEPT** (PG 16
éphémère, migrations appliquées).

> **Note de cadrage.** La demande d'audit mentionne Firebase ; le projet n'utilise **pas
> Firebase**. Chaque rubrique « Firebase » est mappée sur l'équivalent réel : règles
> Firebase → contraintes/triggers PostgreSQL + gates applicatifs ; collections → schémas
> par contexte ; Firebase Auth → JWT maison ; storage → raw store fichiers + AsyncStorage
> mobile ; optimisation Firebase → optimisation Postgres/API.

---

## 1. Synthèse exécutive

Le socle est **anormalement solide pour un projet de cette taille** : architecture
hexagonale réellement outillée (import-linter en CI de fait), doctrine append-only avec
triggers de non-mutation en base, gate anti-fabrication du LLM, idempotence bout-en-bout,
454 tests verts, et un journal de chantier (`CLAUDE.md`) qui trace chaque décision. Les
faiblesses ne sont pas structurelles : ce sont (a) trois **actions manuelles de sécurité
en souffrance** (rotation de clé en tête), (b) des **écrans mobiles trop volumineux**,
(c) un lot de **validations sur device jamais faites**, et (d) l'écart assumé
« pilote mono-utilisateur » → « SaaS multi-tenant » déjà cartographié dans
`PROD-READINESS.md`. Verdict : **prêt pour un pilote sérieux ; pas encore vendable à un
grand compte** (identité/RBAC/SSO restent le bloquant n° 1).

---

## 2. Points forts

**Architecture**
- Backend en monolithe modulaire **hexagonal, vérifié par l'outil** : 6 bounded contexts
  (`ingestion`, `traceability`, `haccp`, `compliance`, `audit`, `identity`), couches
  adapters → application → domain, **5 contrats import-linter KEPT** — la règle « le
  domaine ne dépend de rien » n'est pas un vœu, elle casse le build.
- Ports & adaptateurs sur OCR/LLM (providers remplaçables, ADR-0002) ; outbox
  transactionnel entre ingestion et extraction (workers scalés ×2, `SKIP LOCKED`).
- Mobile : séparation nette **logique pure testable** (`services/*` sans I/O) vs I/O
  (`api`, `scanQueue`, `outbox`) vs rendu ; le port `ArticleStore` prépare la migration
  SQLite sans toucher les écrans.
- Décisions documentées : 7 ADR + contrats API (`API-CONTRACTS.md`, `openapi.v1.yaml`).

**Fiabilité des données (le « règles Firebase » local)**
- Append-only **imposé par triggers PG** (`deny_mutation`) — l'immutabilité survit à un
  bug applicatif. Corrections humaines = nouveau `extraction_run`, `source='human'`,
  jamais d'écrasement ; overrides GS1 sous flag `force_gs1` avec action d'audit dédiée.
- Idempotence à trois étages : hash de contenu (dédup ingestion), `Idempotency-Key`
  serveur (table 0013, rejouable hors-ordre sans résurrection d'anciennes valeurs),
  outbox mobile avec clés stables + purge.
- Gate anti-fabrication (inconnu ⇒ `null`, jamais inventé) testé par cas de non-régression
  (`docs/extraction/test-cases/`).

**Code & tests**
- 212 tests mobiles **sur de la logique pure** (pas de snapshot fragile), 242 backend dont
  proofs d'immutabilité/rollback sur vraie base ; TypeScript sans erreur ; conventions de
  nommage homogènes (domaine métier en français dans l'UI, anglais dans le code).
- Erreurs : catalogue problem+json unifié côté serveur ; côté mobile, aucun code technique
  n'atteint l'opérateur (machine 12 statuts → libellés FR, passe santé du 3 juillet).

**UX / Performance**
- Latence perçue travaillée en profondeur et **mesurée** (cascade 3 vagues, long-poll,
  soumission spéculative, `overlap_ms` loggé) ; liste O(1) au scroll (`getItemLayout`,
  hauteurs fixes mesurées), `React.memo` sur les cartes, `useDeferredValue` sur la
  recherche ; images recadrées ≤1600 px avant upload.
- Design system tokenisé (couleurs/typo/espacements), direction sobre cohérente ;
  accessibilité de base réelle (`accessibilityRole/Label/State` systématiques).

---

## 3. Points faibles

**Architecture / code (mobile)**
- **Écrans trop volumineux** : `ReviewScreen.tsx` **957 lignes**, `ArticleDetailScreen`
  711, `ArticleListScreen` 670. La logique est déjà externalisée (services purs), mais le
  JSX + câblage accumulés rendent la revue de code et les modifications risquées. Pas de
  bug identifié — un coût de maintenance.
- **Duplication de motifs UI** : le geste swipe-supprimer est répliqué entre
  `ArticleCard` et `PendingScanCard` (assumé en v2.1) ; les deux panneaux dépliants du
  header (recherche, calendrier) dupliquent le patron Animated ; `dayTitle`/`pendingTitle`
  sont deux styles identiques. Un composant `SwipeToDelete` et un `HeaderSlidePanel`
  factoriseraient trois copies.
- **Code mort / vestiges** : `components/ScanStepper.tsx` n'est plus importé nulle part
  (v2.1 a gardé le service `scanSteps`, pas le composant) ; le flag `BACKEND_FIRST`
  (`config.ts`) ne pilote plus qu'un refus — l'opt-out qu'il désignait a été supprimé ;
  dépendance `expo-status-bar` non utilisée (le `StatusBar` vient de `react-native`).
- Aliases de rétro-compat dans `RootNavigator.ts` (`CaptureStackParamList`,
  `ArticlesStackParamList`) à résorber.

**Sécurité**
- ⚠️ **Rotation de la clé Google Vision toujours pas faite** (P0 depuis le 2 juillet) :
  l'ancienne clé, jadis inlinée dans des bundles Expo produits avant l'audit §7.3, reste
  extractible de ces builds. Code corrigé, **action console Google manquante**.
- **Pas de rate limiting** (notamment `POST /v1/auth/login`) : brute-force possible ;
  le catalogue d'erreurs prévoit `RATE_LIMITED` (429) mais aucun middleware ne l'émet.
- **Mono-compte admin** en variables d'env, JWT sans refresh ni révocation ; pas de RBAC
  nominatif (cartographié Phase 1 de la roadmap — bloquant grands comptes, pas pilote).
- Secrets en `.env` montés (pas de gestionnaire de secrets) ; TLS délégué au déploiement
  (aucune terminaison dans le repo) ; `LABELSCAN_ALLOW_HEADER_AUTH` est bien **désactivé
  par défaut** (seam de dev correctement gardé — point vérifié, non problématique).

**UX / device**
- **Checklists device en souffrance** (fin de `CLAUDE.md`) : gestes visionneuse iOS/
  Android, tir enchaîné 5 photos, kill/relance pendant extraction, mode avion, swipe des
  cartes, chips d'historique, **et le module calendrier v1.1** — beaucoup d'UI validée
  uniquement par types + tests purs, jamais à l'œil sur appareil.
- Clavier température Android : signe moins peu accessible (`numbers-and-punctuation`
  est iOS-only) — choix assumé, à revoir à l'essai terrain.
- Accessibilité : pas d'audit tailles de police dynamiques / contraste systématique
  (spot-check OK, pas de garantie) ; cible tactile des cases calendrier 36 px (< 44 px
  Apple HIG) — acceptable en grille dense, à surveiller.
- Photos pré-v2 non pivotées s'affichent en portrait (caveat legacy documenté).

**Performance / scale**
- AsyncStorage atteint ses limites vers quelques milliers d'articles (recherche en
  mémoire, pas d'index) ; le port `ArticleStore` est prêt mais `SqliteArticleStore`
  n'existe pas encore. Le calendrier (countByDay O(n)) est indolore aujourd'hui, à
  réévaluer au même seuil.
- La latence brute réelle est **inconnue en prod-like** : les ~20 s mesurées étaient
  dominées par l'egress Docker-macOS (~0,5 Mo/s) ; la re-mesure (P1, action manuelle)
  conditionne tout investissement latence supplémentaire.
- Polling long-poll efficace pour un pilote ; LISTEN/NOTIFY + SSE identifiés comme
  upgrade path si la flotte de devices grossit.

**Maintenabilité / documentation**
- `CLAUDE.md` (≈600 lignes) est un excellent **journal**, mais c'était jusqu'ici le seul
  point d'entrée global — illisible pour un nouveau venu. **Corrigé en v1.1** : README
  racine + `TECH-REVIEW.md` + `DEVELOPER-GUIDE.md` (ce lot de livraison).
- `docs/database/migrations/` (copies SQL 0001-0009) diverge de `server/migrations/`
  (Alembic, source de vérité jusqu'à 0013) — risque de confusion.
- Un test backend connu ordre-dépendant (documenté) ; tolérable, mais c'est le genre de
  flakiness qui pourrit une CI plus tard.

---

## 4. Problèmes critiques (à traiter avant toute mise en service)

| # | Problème | Preuve | Action |
|---|---|---|---|
| C1 | **Clé Google Vision compromise-potentielle non tournée** | `CLAUDE.md` §P0 (2 juil.), toujours ouvert | Régénérer dans Google Cloud Console, restreindre à l'API Vision + IP serveur, mettre à jour `server/.env` uniquement |
| C2 | **Aucun rate limiting sur l'auth** | `platform/http/` : aucun middleware ; catalogue 429 inutilisé | Middleware simple (compteur par IP/username, fenêtre glissante) au moins sur `/v1/auth/login` |
| C3 | **UI critique jamais validée sur device** | Checklists cumulées v1→v1.1 en fin de `CLAUDE.md` | Une session device unique qui purge TOUTES les checklists |

Aucun problème critique de **données** n'a été trouvé : l'append-only, l'idempotence et
le no-fab sont testés et tenus.

---

## 5. Recommandations priorisées

**P0 — sécurité / intégrité (jours)**
1. Rotation clé Vision (C1). 2. Rate limiting auth (C2). 3. Session device (C3).

**P1 — qualité de code & hygiène (heures, sans risque)**
4. Supprimer `ScanStepper.tsx` + retirer `expo-status-bar` + retirer le flag
   `BACKEND_FIRST` et sa branche morte dans `CameraScreen` + aliases navigation.
5. Factoriser `SwipeToDelete` (ArticleCard/PendingScanCard) et `HeaderSlidePanel`
   (recherche/calendrier) ; fusionner `dayTitle`/`pendingTitle`.
6. Supprimer `docs/database/migrations/` (ou README « copie historique, voir Alembic »).

**P2 — dette structurante (jours→semaines)**
7. Découper `ReviewScreen` (extraire `FieldRow`+clavier par type, bloc photo, bloc
   suggestions) — objectif < 400 lignes par écran, zéro changement de comportement.
8. `SqliteArticleStore` derrière le port existant (migration one-shot déjà spécifiée,
   Fix 7.2) — déclencheur : premiers tests device à volumétrie réelle.
9. Re-mesure latence prod-like (`extraction_timing` hors Docker-macOS) puis arbitrer
   OCR vs push (SSE/LISTEN-NOTIFY).
10. Fixer le test backend ordre-dépendant.

**P3 — trajectoire produit (roadmap existante, inchangée)**
11. Phase 1 `IMPLEMENTATION-ROADMAP.md` : identité nominative, RBAC, spike RLS
    multi-tenant. 12. Industrialisation (PG managé + backups, stockage objet, secrets
    manager, CI/CD hors compose). 13. Éval IA continue (hit-rate cache, taux escalade
    Opus, coût/scan). 14. Distribution MDM vs stores.

---

## 6. Quick wins (< 1 h chacun)

- Suppression du code mort (reco 4) — ~600 lignes en moins, zéro risque (aucun import).
- README des migrations historiques (reco 6).
- Ajouter `npm run lint` (ESLint config Expo) — le repo n'a **aucun linter JS** ;
  typecheck+tests compensent, mais un lint attraperait les imports morts automatiquement.
- Brancher `run_local_proofs.sh` + `npm test` dans un hook pre-push ou une CI GitHub
  Actions minimale (le dépôt est sur GitHub, aucune CI aujourd'hui).
- Épingler le port du long-poll dans `.env.example` serveur (doc des variables déjà
  faite au README v1.1).

## 7. Dette technique (inventaire consolidé)

| Dette | Origine | Coût si ignorée | Réf. |
|---|---|---|---|
| AsyncStorage sans index | choix v0 assumé | recherche lente > ~5k lots | Fix 7.2 |
| Écrans monolithiques | accrétion v1→v2.1 | vélocité en baisse, régressions UI | reco 7 |
| Mono-compte admin | seam volontaire | bloque vente grands comptes | Phase 1 |
| Polling (long-poll) | suffisant pilote | charge serveur ∝ devices | Tier 2/4 |
| Pas de CI | repo jeune | dérive silencieuse (les 454 tests ne tournent que si on y pense) | quick win |
| Pas de linter JS | idem | code mort récurrent (ScanStepper en est la preuve) | quick win |
| Photos legacy non pivotées | v2 assumé | cosmétique, s'éteint seul | — |
| Test backend ordre-dépendant | connu | flakiness CI future | reco 10 |

## 8. Roadmap technique proposée (fusion avec l'existante)

1. **S0 (immédiat)** : P0 (rotation clé, rate limit, session device) + quick wins.
2. **S1-S2** : P1 hygiène + découpage `ReviewScreen` + CI GitHub Actions
   (typecheck + jest + proofs backend).
3. **S3-S6** : re-mesure latence → arbitrage push ; `SqliteArticleStore` si volumétrie ;
   début Phase 1 identité/RBAC. **Jalon : pilote payant** (cohérent roadmap ≈ S6).
4. **M2-M5** : multi-tenant (RLS), industrialisation infra, éval IA continue,
   distribution. **Jalon : contrat groupe** (`PROD-READINESS.md`).

---

*Audit réalisé sur l'arbre de travail du 6 juillet 2026 (v1.1, module calendrier
inclus, non commité au moment de l'audit). Preuves d'exécution : sorties `tsc`, jest,
`run_local_proofs.sh` du jour.*
