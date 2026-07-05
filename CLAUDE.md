rr# claude.md — Architecture Frontend, Refonte UI, Search & Haiku Prompting
**Date :** 21 Juin 2026
**Modèle d'exécution :** Claude Opus 4.8 (Lead Architect & AI Prompt Engineer)

## 🧠 Déploiement des Agents Custom
1. **Frontend System Architect :** Architecture scalable, logique de recherche omnisciente.
2. **UX/UI Minimalist & Technical Writer :** Interface épurée, français métier, focus sur la photo et la vitesse perçue.
3. **AI Prompt Engineer :** Spécialiste OCR pour Haiku 4.5 (FAO ultra-précise).
4. **Security DevOps :** Préparation de commits propres, sans clés privées.

## 🎯 Directives d'implémentation strictes

**1. Clean UI Radicale & "No-Nonsense"**
- **Interdiction absolue** des éléments suivants dans la vue d'enregistrement et les détails d'articles :
  - Pas de tag "Modifié" ou "Édité" (la validation manuelle devient la vérité absolue).
  - Pas de tag "À vérifier".
  - Pas de pourcentage de validation ou de score de confiance de l'IA.
- Élimine les sous-titres et descriptions verbeuses. Les labels métier suffisent.
- Uniformisation globale : Poids en `Kg`, températures en `°C`, dates au format `21 juin 2026`.

**2. Refonte "Page Enregistrement" (Vitesse & Photo)**
- **Mise en valeur de la photo :** Parfaitement découpée (`object-fit: cover`, angles arrondis), visuellement agréable et centrale, sans casser la sobriété globale.
- **Vitesse perçue (Chargement en Cascade) :** L'utilisateur ne doit pas attendre Haiku.
  - Étape 1 : Affichage immédiat de la photo et des datas décodées instantanément via GS1-128 (Lot, GTIN, Poids).
  - Étape 2 : Skeletons Loading fluides sur les champs complexes (FAO, Nom, etc.).
  - Étape 3 : Remplacement des Skeletons dès la résolution de l'OCR Haiku.

**3. Page d'Accueil & Moteur de Recherche**
- **Tri Accueil :** Affichage en liste groupée par `Jour d'enregistrement` > puis triée par `Nom commun de poisson` par ordre alphabétique au sein de la journée.
- **Omni-Search :** Implémentation d'une barre de recherche globale capable de requêter tous les champs possibles de la DB enregistrés par labels (Numéro de lot, espèce, zone FAO, etc.).

**4. Prompting Haiku (FAO) & Sécurité Git**
- **Prompt Haiku 4.5 :** Rédige le prompt système exact pour extraire la zone FAO avec **tous ses déterminants** (Zone majeure, Sous-zone, Division, Sous-division, ex: 27.8.b.1) en croisant avec le texte brut.
- **Sécurité :** Tout le code généré pour le commit doit exclure les clés d'API (utilisation stricte de variables d'environnement).

## 📦 Livrables Attendus
1. Architecture frontend, store/hook de l'Omni-Search, et composant `HomePage` (trié).
2. Composant `SaveArticleView` (cascade loading, design photo, zéro tags/pourcentages IA).
3. Le prompt système exact de Haiku 4.5 pour l'extraction FAO.
4. Les commandes git/scripts prêts à commiter (sans secrets).

---

## 🗺️ Roadmap correctifs — Audit latence/UX/cohérence (21 juin 2026)

Suivi de **tous** les correctifs identifiés à l'audit (latence, flux GS1→LLM, cohérence,
saisie, nettoyage UI). Trois horizons : quick wins (faits), moyen terme, fond.

### ✅ Quick wins — FAITS (21 juin 2026)
- [x] **§1.2 Cadence de polling** : cadence plate ~1 s sur les 12 premières tentatives au
  lieu du backoff exponentiel → ~3-5 s d'attente morte en moins par scan. `src/services/ingestionPolling.ts`
- [x] **§6.1 Notification caméra** : suppression du badge/point rouge (`colors.error`) sur le
  FAB de capture. `src/components/CaptureFab.tsx`, `src/screens/ArticleListScreen.tsx`
- [x] **§6.2 Tag « À vérifier »** : retiré + confiance IA sortie du chemin UI (module
  `fieldStatus` supprimé) ; ne reste qu'« À compléter » sur champ vide. `src/screens/ReviewScreen.tsx`
- [x] **§1.4 Upload** : crop redimensionné ≤2000 px + `compress 0.8` (au lieu de 1.0 sans
  resize) → upload/OCR plus rapides. `src/screens/CameraScreen.tsx`
- [x] **§4.1 FAO affichée = stockée** : la valeur FAO est montrée VERBATIM (pleine précision,
  ex. `27.8.b.1`) ; le nom de zone devient un sous-titre décoratif, jamais la valeur
  canonique. `src/services/fieldLabels.ts`, `src/screens/ArticleDetailScreen.tsx`
- [x] **§5 Clavier prix** : `decimal-pad` sur le champ `price`. `src/screens/ReviewScreen.tsx`

### 🔜 Moyen terme — ✅ LIVRÉ (21 juin 2026) ; §6.3 livré le 5 juillet 2026 (voir refonte v1)
- [x] **§1.3 Double aller-retour** : champs du dernier run embarqués dans la réponse de statut
  (`IngestionView.latest_fields`) → `useIngestionResult` construit le run sans 2e fetch (fetch
  gardé en fallback). `read_router.py`, `useIngestionResult.ts`. (Endpoint `/status` allégé :
  optionnel, non nécessaire — le payload reste léger tant qu'aucun run n'existe.)
- [x] **§2.1/2.2 Cascade par champ + zéro layout shift** : liste stable à 16 lignes (`FIELD_ORDER`)
  dès T+0, lignes GS1 préremplies (`gs1FieldValues`), skeleton en place (`SkeletonValue`) sur les
  champs LLM, swap au ready sans saut. `ReviewScreen.tsx`, `SkeletonFieldList.tsx`.
- [x] **§7.1 Re-renders** : `React.memo(EditableFieldRow)` + callback `(name,text)` stable ;
  `React.memo(ArticleCard)` + `renderItem`/`onOpen` stables + FlatList (`getItemLayout`,
  `initialNumToRender`, `windowSize`). `removeClippedSubviews` volontairement omis (cartes
  gesture+reanimated, glitches non vérifiables sans device).
- [x] **§1.5 Débit worker** : `deploy.replicas: 2` + retrait `container_name` (`SKIP LOCKED` déjà
  multi-worker ; validé `docker compose config`). `docker-compose.yml`. (OCR/LLM concurrents
  intra-ingestion = itération ultérieure.)
- [x] **§6.3 Photo** : ✅ LIVRÉ (5 juillet 2026, refonte workflow v1). Carte cover arrondie
  (Review + Détail) + visionneuse plein écran (`PhotoViewerModal.tsx`, pinch/pan/double-tap) — le
  rognage devient sans perte puisque le tap ouvre la photo en `contain`. Voir §🔁 ci-dessous.

### 🏗️ Fond — plans d'action détaillés

#### Fix 4.2 — Persistance des corrections humaines côté backend (cohérence HACCP) — ✅ LIVRÉ (21 juin 2026)
**Statut.** `PATCH /v1/ingestions/{id}/fields/{name}` (scope `extraction:review`) livré :
override use case (`override_field.py`) + adaptateur SQL append-only (`sql_field_override_repository.py`,
nouveau `extraction_run` copié, champ `source='human'`, original conservé) + garde GS1-owned
(409 `FIELD_NOT_EDITABLE`) + idempotence. Mobile : `api.overrideField`, op outbox `override_field`,
`fieldOverrideSubmit.ts` (best-effort, non bloquant), POST au save dans `ReviewScreen`. Vérifié :
import-linter 5/5, `pytest tests/test_field_override.py` (5) + suite backend complète verte,
typecheck + jest mobile (7 tests `fieldOverrideSubmit.test.ts`). Restes possibles (itération
ultérieure) : `POST /v1/ingestions/{id}/confirm` (finaliser le statut), dédup par Idempotency-Key
serveur, drain background de l'outbox mobile. Plan d'origine ci-dessous (référence).

**Mise à jour (5 juillet 2026, refonte workflow v1).** Le garde GS1-owned reste le comportement
par défaut (409 sans flag), mais la garde n'est plus absolue : `force_gs1: true` dans le body
PATCH fait accepter l'override sous l'action d'audit dédiée `ingestion.gs1_field_overridden`
(append-only, `source='human'`, jamais un écrasement). Mobile : `fieldOverrideSubmit.ts` tague
automatiquement les champs GS1 avec `force_gs1` — les 17 champs sont éditables des deux écrans
(Review, Détail article). Voir §🔁 ci-dessous et `docs/backend/API-CONTRACTS.md` §3.

**Problème.** Les corrections de revue ne vivent que dans l'AsyncStorage du device
(`src/types/Article.ts:18`, `src/services/storage.ts`) ; le backend garde la valeur machine.
Le magasin autoritatif (audit, exports serveur) n'a donc pas la vérité validée.
**Objectif.** Toute valeur confirmée/corrigée par l'opérateur est écrite côté serveur,
append-only, auditable, `source='human'`.
**Étapes.**
1. Backend : implémenter `PATCH /v1/ingestions/{id}/fields/{name}` (déjà spécifié API-CONTRACTS)
   → use case `OverrideField` (application) → **nouveau `extraction_run` append-only**
   (`outcome=human_validated`), jamais d'overwrite (ADR-0003) ; audit context = opérateur
   authentifié. Réutiliser `extracted_field.source='human'` (déjà présent dans `reconciliation`).
2. Garde-fous : seuls les champs free-text + FAO sont éditables ; les champs GS1-exacts
   (`_GS1_OWNED_FIELDS` : lot/DLC/GTIN/poids/emballage) ne sont pas écrasables sans flag explicite.
3. Mobile : au save, après `saveBackendArticle` local, POSTer chaque champ `edited` via une file
   outbox locale (modèle `ingestionSubmit.ts`) pour la résilience offline.
4. Logs de vérification : `field_overridden` (ingestion_id, field, ancienne→nouvelle valeur,
   actor) + assertion « valeur affichée == valeur envoyée ».
**Acceptation.** FAO corrigée récupérable via `GET /v1/extraction-runs/{id}` avec `source='human'` ;
aucun run précédent écrasé (test append-only) ; export backend reflète la valeur validée.
**Risques.** Offline (file locale), conflits multi-device (last-write-wins horodaté + audit),
périmètre des champs éditables. **Effort : M-L.**

#### Fix 7.2 — Persistance locale : blob AsyncStorage → SQLite indexé (scale + cohérence) — ✅ LIVRÉ (21 juin 2026)
**Statut.** Approche **port + adaptateurs** (décision produit : interface testable maintenant,
expo-sqlite branché plus tard — le module natif n'est pas vérifiable en jest/Node ici). Livré :
`ArticleStore` (port, `articleStore.ts`) + `InMemoryArticleStore` (tests/référence) +
`AsyncStorageArticleStore` **une clé par article** (`@labelscan:article:<id>`) → fin du blob unique :
plafond ~6 Mo supprimé, writes O(1), getById O(1) ; `raw_extraction_run` sorti du chemin chaud
(clé `@labelscan:articleRaw:<id>` lazy — write-only, aucune UI ne la lit) ; migration one-shot du
blob legacy sans perte (blob conservé en secours). Facade `storage.ts` : API publique inchangée
(écrans non touchés) + seam `setArticleStore()` pour brancher `SqliteArticleStore` (expo-sqlite,
colonnes indexées + FTS5) plus tard sans rien changer d'autre. Vérifié : typecheck 0 erreur +
`articleStore.test.ts` (contrat ×2 adaptateurs + migration), 108 tests jest verts. **Reste (séparé,
non inclus) :** canonicalisation dates ISO (étape 4) — touche l'affichage multi-écrans, à traiter
avec le Fix 5. Plan d'origine ci-dessous (référence).

**Problème.** Un seul blob JSON contient TOUS les articles, chacun embarquant
`raw_extraction_run` complet (`src/services/storage.ts:115`, `src/types/Article.ts:41`).
Réécriture O(n) à chaque save ; **plafond ~6 Mo (CursorWindow Android) → échec silencieux** à
quelques milliers d'articles. Dates en double représentation (DD/MM/YYYY vs ISO).
**Objectif.** Writes O(1), lecture par id O(1), recherche indexée, pas de plafond, une seule
représentation canonique (ISO) en stockage.
**Étapes.**
1. `expo-sqlite` : table `articles` (index id, saved_at, common_name) + `article_fields`
   (article_id, field_name, value) pour la recherche SQL ; `raw_extraction_run` sorti du chemin
   chaud (table `article_raw` lazy).
2. Migration au 1er lancement : lire l'ancien blob → insérer en SQLite → marquer migré →
   conserver le blob N jours en secours puis purger (test de non-perte).
3. Réécrire `src/services/storage.ts` (getAll/getById/save/delete) sur SQLite, **interface
   publique inchangée** (les écrans ne bougent pas).
4. Dates : stocker ISO canonique dans `value`, formater DD/MM/YYYY seulement à l'affichage
   (corrige la double représentation §4.4).
5. Recherche : garder l'index mémoire (déjà rapide via `useDeferredValue`) ou passer à SQL
   `LIKE`/FTS5 au-delà de ~10k lots.
**Acceptation.** 10 000 articles : save < 50 ms, ouverture détail < 20 ms, recherche fluide ;
migration sans perte ; plus aucune lecture/écriture du blob global.
**Risques.** Migration sur device réel, disponibilité FTS5 selon build Expo. **Effort : M-L.**

#### Fix 5 — Saisie mobile : affixes, validation temps réel, cohérence — ✅ LIVRÉ (21 juin 2026)
**Statut.** Étapes 1-4 livrées. `PriceInput` (affixe €/devise, défaut EUR) + `parsePrice`/`formatPrice`
dans `inputMasks.ts`. Validateurs purs non bloquants `validateDate` (jour/mois/année + bissextile),
`validateTempRange` (min ≤ max + outliers), `validateWeight` (> 0) → indice **neutre** sous le champ
(jamais de rouge, jamais bloquant ; l'opérateur reste maître). Dates **canonisées ISO** au save via
`toIsoDate` (inverse exact de `displayDate`) → fin de la double représentation (§4.4) ; `changed`
comparé en ISO → plus de faux « édité » (§5.3) ; `displayFieldValue` formate les dates au détail.
Cohérence (§4.3) : garantie par construction (`toIsoDate`↔`displayDate` round-trip testé), pas de
log runtime. Vérifié : typecheck 0 erreur + 14 tests purs (`inputMasks.test.ts`), 122 jest verts.
**Reste (objectif 3, séparé) :** étape 5 — autocomplétion par champ depuis l'historique. Plan
d'origine ci-dessous (référence).

**Problème.** Prix sans affixe devise (quick win `decimal-pad` fait) ; pas de validation temps
réel (date `32/13`, temp hors borne) ; `changed`/`displayDate` calculé avant normalisation peut
marquer une date inchangée comme « éditée » (`src/screens/ReviewScreen.tsx`).
**Objectif.** Saisie assistée, sans friction, validée au fil de la frappe, cohérente avec les
affixes poids/température existants ; jamais de calcul/auto-complétion d'une valeur (gate no-fab).
**Étapes.**
1. `PriceInput` (affixe €/devise) sur le modèle de `WeightInput` ; `parsePrice`/`formatPrice`
   dans `inputMasks.ts` + tests (parité `parseWeight`). Émet `"8.95 EUR"`.
2. Validation pure réutilisable (`inputMasks.ts`/`validation.ts`) : date (jour 1-31/mois 1-12,
   année plausible), température (min ≤ max, plage plausible), poids (> 0). Retour **neutre et
   non bloquant** (pas de rouge alarmiste — cohérent Clean UI), l'opérateur reste maître.
3. Corriger `changed` : le calculer après normalisation ISO et comparer en ISO (évite le faux
   « édité » sur date ré-saisie identique).
4. Cohérence (lien §4.3) : au save, assert `valeur persistée === valeur affichée` par champ +
   log de divergence (corrélé `ingestion_id`).
5. (Optionnel, objectif 3) Autocomplétion par champ depuis l'historique (espèce/fournisseur/FAO)
   via index local des valeurs déjà saisies.
**Acceptation.** Prix = pavé numérique + affixe devise, format stable ; date invalide signalée
sans bloquer ; aucune date inchangée marquée « édité » ; tests purs parsePrice/validateurs.
**Effort : S-M.**

### 🔐 Fond — sécurité & architecture (évoqués, à planifier)
- [ ] **§7.3 OCR client legacy** : retirer (ou import paresseux derrière `BACKEND_FIRST`) le
  chemin `src/services/ocr.ts` + la clé `EXPO_PUBLIC_GOOGLE_VISION_KEY` du bundle JS.
- [ ] **§5-archi Long-poll / SSE** : remplacer le polling par un long-poll (réponse au
  changement de statut, timeout ~25 s) ou SSE → latence perçue ≈ latence serveur réelle.

---

## 🚀 Latence perçue — cascade (Tier 1 / 3 / 5) — session 21 juin 2026 (soir)

> Contexte : la **mesure** (`docs/LATENCY-REVIEW.md` §0) a infirmé l'estimation — réel ≈ **20 s**
> perçu (upload ~6,4 s + post-upload ~14 s), pas 3–9 s. On attaque la latence **perçue** en
> recouvrant l'attente et en donnant du mouvement, sans attendre l'optimisation du temps brut.

### ✅ Tier 1 — Soumission spéculative — LIVRÉ (21 juin 2026)
**Statut.** L'upload + extraction partent **dès la photo prise** (`takePhoto` → `speculativeRef`,
`src/screens/CameraScreen.tsx`), en tâche de fond, pendant la revue photo (Reprendre/Valider).
Valider **consomme** l'outcome spéculatif (sinon submit frais en repli) ; Reprendre/refocus
abandonnent l'ingestion orpheline (append-only, inoffensive — ADR dedup/idempotency inchangés).
`wait_ms` mesuré **depuis Valider** (T0 perçu) ; log capture `speculative`, `cropped`, **`overlap_ms`**
(temps de traitement déjà écoulé AVANT Valider — preuve chiffrée que la photo est traitée dès la prise).
Vérifié : typecheck 0 erreur + 132 jest. **Gain visé** : les ~14 s d'extraction recouvrent la pause de
revue → au tap Valider, le run est souvent déjà prêt.

### ✅ Tier 5 — Feedback de progression étagé — LIVRÉ (21 juin 2026)
**Statut.** `services/extractionStage.ts` (pur `extractionStage(elapsedMs, ready)`, testé ×4) +
`components/ExtractionProgress.tsx` : **cascade verticale d'états** (Photo envoyée ✓ · Lecture du
texte… · Analyse…), point actif **qui pulse**. Le `PulseDot` partagé (`components/PulseDot.tsx`)
remplace AUSSI le spinner de `ProcessingOverlay` (upload) → **zéro roue sur le flux capture→revue** ;
rendue pendant `phase==='loading'` dans `ReviewScreen` (remplace le label figé
« Analyse de l'étiquette… »). Piloté par le temps écoulé + la phase réelle (estimations temporisées).
**Se branchera sur l'état réel** dès que Tier 3 l'expose. Sober (Clean UI) : aucun pourcentage/score.
Vérifié : typecheck + 132 jest.

### ✅ Tier 7 — Image plus petite vers Vision + logs + fix formatter — LIVRÉ (21 juin 2026)
**Statut.** Crop client `≤2000 → ≤1600 px` (`CameraScreen.tsx`), `compress 0.8` → base64 plus petit =
upload **et** OCR Vision plus courts (l'OCR est **co-dominant**, mesuré §0 du LATENCY-REVIEW : OCR
~12 s, LLM ~9 s). **Logs ajoutés** : `image_bytes` (worker, dans `extraction_timing` — taille réelle
envoyée à Vision, corrèle avec `ocr_ms`) + `cropped` (client). **Bug formatter corrigé au passage**
(`observability.py`) : la `JsonFormatter` allow-list **droppait** `ocr_ms`/`llm_ms` → le split était
invisible malgré le worker à jour ; `ocr_ms`/`llm_ms`/`attempts`/`image_bytes` ajoutés à l'allow-list.
Vérifié : typecheck + 132 jest ; `test_observability` relu (propriété « secrets droppés » intacte) ;
worker rebuild. **⚠️ Caveat** : les ~21 s mesurés sont **dominés par l'egress Docker-macOS** (~0,5 Mo/s,
~600 ms/appel) — **remesurer en prod-like** avant d'investir plus. **Reste** : `TEXT_DETECTION` +
≤1280 px si le recall tient ; réutilisation de connexion httpx (−~600 ms/appel).

### ✅ Tier 3 — Cascade par vagues : déterministe avant le LLM — LIVRÉ (2 juillet 2026)
**Statut.** Livré bout-en-bout, backend + mobile :
- **Domaine** : `ingestion/domain/interim_fields.py` (pur) — extracteurs regex conservateurs
  sur `ocr.full_text` : dates À LABEL EXPLICITE uniquement (DLC/à consommer jusqu'au →
  `expiry_date` ; emballé/conditionné le → `packaging_date`), plages de température franches
  (« entre 0°C et +4°C » → `0-4 C`), prix avec € explicite (→ `8.95 EUR`, €/kg exclu),
  lot après clé « Lot » (verbatim). Règle d'ordre des dates = celle du prompt (composant >12
  = jour ; les deux ≤12 = ambigu → RIEN). Plusieurs candidats distincts pour un champ → champ
  non émis. **Formes canoniques identiques au contrat LLM** → le run final confirme sans
  flicker. 23 tests purs (`test_interim_fields.py`).
- **Migration 0012** : table `ingestion.interim_field` append-only (triggers `deny_mutation`,
  `UNIQUE (ingestion_id, field_name)`, grant SELECT/INSERT) — aperçu NON autoritatif, jamais
  lu une fois un run présent.
- **Worker** (`extraction_consumer.py`) : `_persist_interim` entre l'OCR (après gate qualité)
  et le LLM, **transaction propre** (hors `worker_conn`), `ON CONFLICT DO NOTHING` + statut
  `raw_stored → ocr_done` guardé (`WHERE status IN (raw_stored, ocr_running)` → jamais de
  régression d'un statut terminal sur redelivery) ; **best-effort** (un échec de l'aperçu ne
  fait jamais échouer l'extraction) ; champs **réellement résolus par GS1 skippés** (le
  code-barres exact n'est jamais contredit par une regex). Log `interim_persisted`
  (+ `interim_field_count` ajouté à l'allow-list `observability.py`).
- **API** (`read_router.py`) : `IngestionView.interim_fields` exposé **uniquement tant
  qu'aucun run n'existe** → un échec LLM ne laisse jamais un aperçu affiché comme définitif.
- **Mobile** : `ocr_done` classé processing + callback `onInterim` (dédupliqué, 1 tir par
  changement d'état) dans `ingestionPolling.ts` ; `useIngestionResult` expose
  `interimValues` + `ocrDone` ; `ReviewScreen` préremplit les `PendingFieldRow`
  (priorité GS1 > interim ; dates ISO → JJ/MM/AAAA) sans layout shift ; `ExtractionProgress`
  passe au stage `llm` **réel** dès `ocr_done` (fin de l'estimation temporisée, Tier 5 branché).
- **Vérifié** : backend 225 passed + 1 skip connu + import-linter 5/5 KEPT
  (`run_local_proofs.sh`, PG éphémère) ; mobile typecheck 0 erreur + 138 jest verts
  (4 tests d'intégration `test_interim_wave.py` : happy path, idempotence/redelivery,
  exclusion GS1, endpoint avant/après run).
**Synergie restante** : Tier 4 (long-poll/SSE) pour pousser la vague 2 sans attendre le poll.
Plan d'origine ci-dessous (référence).

**Problème (plan d'origine).** Le worker (`extraction_consumer.__call__`) fait GS1 → OCR → gate qualité → LLM → gate
no-fab → réconciliation → persist dans **une seule transaction** (`worker_conn`), et n'expose qu'un
statut terminal (`extracted`). Le client ne voit donc **rien entre l'OCR et la fin du LLM** : la
vague 2 « champs déterministes par regex sur le texte OCR » (dates, température, prix, motifs de lot),
visible **avant** la fin du LLM, est impossible sans données intermédiaires côté serveur.
**Objectif.** Afficher la donnée en **3 vagues** : V1 GS1 (T+0, déjà fait), **V2 regex/OCR (~OCR fini,
~1,5–2 s)**, V3 LLM (~3–5 s). L'écran se remplit en continu → vitesse perçue ≫ réelle ; le bandeau
Tier 5 se cale sur les vraies transitions.
**Étapes.**
1. **Domaine** : module pur `interim_fields.py` — extracteurs **regex conservateurs** sur `ocr.full_text`
   (dates ISO/FR, `storage_temperature`, `price`, motifs `batch_number`). Émet **uniquement** sur
   match franc (jamais de fabrication — cohérent gate no-fab) ; `source='deterministic'`, **non
   autoritatif** (le run final reconcilié reste la vérité). Tests purs (échantillons OCR réels).
2. **Worker** : après l'OCR (et le gate qualité), **commit intermédiaire** sur une connexion *propre*
   (hors `worker_conn` relai) → écrire les `interim_fields` + bumper le statut `raw_stored` →
   **`ocr_done`** (nouveau statut non terminal). Puis poursuivre LLM → persist final **inchangé**
   (append-only, le run final supersède l'aperçu). Réversible : si le LLM échoue → run `FAILED`,
   l'aperçu est marqué superseded (jamais montré comme définitif).
3. **Statut** : exposer `interim_fields` dans la réponse `GET /v1/ingestions/{id}` (modèle
   `latest_fields`, `read_router.py`) ; `ocr_done` classé **processing** mais porteur d'un payload.
4. **Mobile** : `pollIngestionUntilReady` apprend un état **intermédiaire** (continue de poller mais
   remonte les `interim_fields` via callback/variant) ; `useIngestionResult` rend V2 puis V3 sans
   layout shift (mêmes lignes `FIELD_ORDER`, skeleton → preview → éditable) ; `ExtractionProgress`
   passe en mode **réel** (ocr→llm depuis le statut, fin des estimations).
**Acceptation.** Sur un scan sans code-barres : dates/temp/prix **apparaissent à ~2 s** (avant le
LLM) puis sont confirmés/complétés au run final, **sans saut ni flicker** ; un échec LLM ne laisse
jamais un aperçu affiché comme validé ; replay/dedup idempotents ; suite backend verte (stack lancée).
**Risques.** Chemin chaud append-only + **2ᵉ commit** (états partiels, visibilité intermédiaire) ;
flicker si regex et LLM divergent (→ extracteurs conservateurs + le run final tranche) ; flakiness
ordre-dépendante de la suite backend (vérifier `docker compose`). **Synergies** : Tier 4 (long-poll/SSE)
pour pousser V2 sans poll ; Tier 2 (LISTEN/NOTIFY) pour le pickup ; Tier 5 déjà prêt à se brancher.
**Effort : L.** **Prérequis** : stack lancée + relire `extraction_timing` (split OCR/LLM, §0) pour
caler le seuil V2 sur la vraie durée OCR.

---

## 🗺️ Backlog priorisé — état au 2 juillet 2026 (post-Tier 3)

> Note mesure : les derniers `ocr_ms` observés sont **nettement plus bas** que la série du
> 21 juin (~12,4 s) — le Tier 7 (image ≤1600 px + fix formatter) paie. Conséquence : la
> vague 2 du Tier 3 arrive d'autant plus tôt, et **la priorité bascule de « réduire l'OCR »
> vers « pousser plus vite ce qui est prêt » (Tier 4) + industrialisation.** Confirmer avec
> une série `extraction_timing` propre avant tout nouvel investissement latence brute.

### P0 — Sécurité — ✅ CODE LIVRÉ (2 juillet 2026) ; ⚠️ ROTATION DE CLÉ = ACTION MANUELLE
- [x] **§7.3 OCR client legacy SUPPRIMÉ** : `src/services/ocr.ts` effacé (un import paresseux
  n'aurait PAS suffi — Expo inline les `EXPO_PUBLIC_*` dans le bundle à la compilation) ;
  branche legacy de `CameraScreen` neutralisée (alerte « mode hors serveur indisponible »,
  constantes `ZONE_*` mortes retirées) ; `EXPO_PUBLIC_GOOGLE_VISION_KEY` purgée de `.env` et
  `.env.example` ; commentaires `config.ts` mis à jour. Typecheck 0 + 138 jest.
- [ ] **⚠️ FAIRE TOURNER LA CLÉ VISION dans Google Cloud Console** (action manuelle) : la clé
  reste extractible de tout build/bundle DÉJÀ produit. Régénérer, restreindre à l'API Vision +
  au serveur, mettre à jour `server/.env` (`LABELSCAN_GOOGLE_VISION_API_KEY`) uniquement.

### P1 — Mesure + quick wins latence — ✅ CODE LIVRÉ (2 juillet 2026) ; mesure = action manuelle
- [ ] **Remesurer en prod-like** (hors egress Docker-macOS ~0,5 Mo/s) : série
  `extraction_timing` (ocr_ms/llm_ms/image_bytes) + `wait_ms` client. Les OCR récents plus
  rapides sont peut-être déjà le vrai niveau. Effort : S. **Bloque** : arbitrage Tier 4 vs OCR.
- [x] **httpx.Client partagé** dans `google_vision_ocr.py` : un client par instance d'adaptateur,
  créé paresseusement au 1er `run()` (construction sans I/O préservée), connexion TCP+TLS
  réutilisée sur toute la vie du worker (−~600 ms/appel mesuré Tier 7). Pooling SDK Anthropic
  vérifié OK (un `anthropic.Anthropic()` par adaptateur, réutilisé). Tests MockTransport.
- [x] **`TEXT_DETECTION` exposé en config** : `LABELSCAN_OCR_FEATURE=TEXT_DETECTION`
  (défaut inchangé `DOCUMENT_TEXT_DETECTION`, valeur invalide = échec bruyant au démarrage).
  **NE PAS basculer le défaut sans passer l'éval (SC1/SC3/SC10)** — le flag permet l'A/B prod
  sans changement de code. Le ≤1280 px client reste conditionné à la même éval.

### P2 — Vitesse perçue, suite
- [x] **Tier 4 — long-poll — ✅ LIVRÉ (3 juillet 2026)** :
  `GET /v1/ingestions/{id}?wait=<s>&last_status=<statut>` (read_router) — hold serveur borné
  (clamp 25 s, `clamp_wait`), sonde statut ~300 ms sur connexions courtes (jamais de slot de
  pool retenu), réponse au premier changement ou à l'expiration (état courant, jamais une
  erreur) ; 404 immédiat si l'ingestion n'existe pas ; GET nu inchangé. Mobile :
  `getIngestionStatus(waitSeconds, lastStatus)` ; `pollIngestionUntilReady` — 1er GET
  immédiat (baseline) puis holds successifs, timeout HTTP dimensionné AU-DESSUS du hold,
  budget global 30 s respecté ; **anti-spin** : un hold revenu inchangé en <750 ms (vieux
  serveur qui ignore les params) → retour à la cadence classique ~1 s, jamais de hot-loop ;
  `longPollSeconds: 0` désactive. Vérifié : backend 233 passed (6 tests `test_long_poll.py`)
  + import-linter 5/5 ; mobile typecheck 0 + 141 jest (3 tests Tier 4). Gain : les
  transitions `raw_stored→ocr_done→terminal` (Tier 3) arrivent avec ~0 latence de
  découverte au lieu de ~0-1 s chacune. Upgrade path si le nombre de devices explose :
  LISTEN/NOTIFY (Tier 2) à la place de la sonde, SSE à la place du hold.
- [x] **§6.3 Photo « carte cover arrondie »** (directive §2) : ✅ LIVRÉ (5 juillet 2026,
  refonte workflow v1) — voir §🔁 ci-dessous. **Reste à valider app lancée** (rendu réel,
  gestes de la visionneuse) : voir la checklist device de la refonte.

### P3 — Compléter la boucle de revue côté serveur — ✅ LIVRÉ (3 juillet 2026)
- [x] **`POST /v1/ingestions/{id}/confirm`** : use case `ConfirmIngestion` + `SqlConfirmRepository`
  (FOR UPDATE, transition auditée `ingestion.confirmed`, gate review-ready : extracted /
  needs_review / ocr_skipped_garbage ; déjà confirmé → replayed ; autre état → 409
  `INGESTION_NOT_CONFIRMABLE` ajouté au catalogue problem+json ; absent → 404). Mobile :
  `api.confirmIngestion`, op outbox `confirm_ingestion`, POST au save dans `ReviewScreen`.
- [x] **Dédup serveur par Idempotency-Key** (migration 0013, `ingestion.request_idempotency`
  append-only, PK (endpoint, actor, key)) : un retry de la MÊME requête rejoue le run
  d'origine — même après un edit A→B ultérieur (le retry hors-ordre de A ne ressuscite
  jamais A en 3ᵉ run). Clé passée du header au use case au repo, enregistrée dans la MÊME
  transaction que le run. L'idempotence par valeur (sans clé) est conservée.
- [x] **Drain background de l'outbox mobile** : `services/outboxDrain.ts` — rejoue les écritures
  de revue pendantes (override + confirm) avec leurs clés STABLES, latch anti-concurrence,
  types non gérés laissés en file ; déclenché au foreground (AppState) + au démarrage
  (`App.tsx`) + après chaque save. Vérifié : backend 239 passed (`test_confirm_ingestion.py`
  ×6) + import-linter 5/5 ; mobile typecheck 0 + 144 jest (`outboxDrain.test.ts` ×3).

### 🎨 Cascade visuelle de chargement — ✅ LIVRÉ (3 juillet 2026) — ⚠️ à VALIDER app lancée
- [x] `components/CascadeReveal.tsx` (fade + translate 6 px, 240 ms, stagger `cascadeDelay`
  plafonné 450 ms, RN Animated natif — pas de reanimated) : chaque vague (GS1 → aperçu
  déterministe → LLM) se révèle en balayage haut→bas ; au ready, SEULES les lignes encore en
  skeleton s'animent (une valeur déjà visible ne re-flashe jamais — zéro layout shift
  préservé). `ExtractionProgress` : check animé (pop scale+fade) sur les vraies transitions.
  Typecheck + 144 jest verts ; **le rendu visuel réel reste à valider sur device** (§6.3
  photo « carte cover » toujours en attente d'app lancée).

### 📄 Synthèse prod-readiness — ✅ RÉDIGÉE (3 juillet 2026)
- [x] `docs/PROD-READINESS.md` : les manques pour vendre à un grand groupe, par domaine
  (identité/RBAC/SSO **bloquant n°1**, multi-tenant, infra UE + observabilité + SLA,
  RGPD/DPA/pentest, éval IA continue, distribution MDM, API d'intégration SI) + chemin
  critique en 3 phases (~3-5 mois) + les 3 décisions à prendre tôt (isolation tenant,
  hébergeur/DPA IA, MDM vs stores).

### P4 — Scale local mobile (au moment des tests device réels)
- [ ] **`SqliteArticleStore`** (expo-sqlite, colonnes indexées + FTS5) derrière le port
  `ArticleStore` déjà en place ; migration AsyncStorage→SQLite au 1er lancement. Effort : M.
- [ ] **Autocomplétion par champ depuis l'historique** (espèce/producteur/FAO) — étape 5
  du Fix 5. Effort : S-M.

### P5 — Industrialisation prod (avant mise en service réelle)
- [ ] Postgres managé + backups ; stockage objet (S3-compatible) pour le raw store ;
  secrets hors `.env` monté ; déploiement hors docker-compose local. Effort : L.
- [ ] Métriques d'exploitation : hit-rate cache prompt (`cache_read_input_tokens`), taux
  d'escalade Opus, coût/scan ; Batches API pour les backfills (−50 %). Effort : M.
- [ ] Maintenance récurrente : montée de version Expo SDK ~2×/an. Effort : S récurrent.

---

## 🧭 Plan d'implémentation maître (3 juillet 2026)

Le plan séquencé complet (phases 0-5, dépendances, jalons commerciaux, règles de conduite)
est dans **`docs/IMPLEMENTATION-ROADMAP.md`** — il remplace le backlog priorisé ci-dessus
comme référence d'ordonnancement. Résumé : Phase 0 immédiate (rotation clé, mesure
prod-like, session app lancée §6.3+cascade) → Phase 1 identité nominative/RBAC (extension
de identity.app_user, spike RLS en parallèle) → Phases 2-3 industrialisation + éval IA
(parallèles) → Phase 4 distribution mobile → Phase 5 multi-tenant/SSO/API SI.
Pilote payant ≈ S6 ; contrat groupe ≈ M3-5.

---

## 🩺 Passe santé pré-roadmap — 3 juillet 2026 (soir)

Revue raisonnée saisies/pipeline/rendu avant d'attaquer la roadmap. 4 bugs réels corrigés :

1. **CRASH DEVICE évité — `URLSearchParams` (api.ts)** : le long-poll Tier 4 utilisait
   `URLSearchParams.toString()`, NON implémenté par le polyfill URL de React Native (jette à
   l'exécution ; invisible en jest car Node l'implémente). Query construite manuellement via
   `encodeURIComponent`. **Leçon : jamais d'API Web non vérifiée RN dans le code device.**
2. **Statuts — classifier client aligné sur la machine 12 états** (`ingestionPolling.ts`,
   `types/api.ts`, `fieldLabels.ts`) : un re-scan d'une étiquette déjà validée (dédup par
   hash contenu → même ingestion, statut `confirmed`) tombait en `UNKNOWN_STATUS` → écran
   d'erreur. `confirmed` → review_ready ; `ocr_running`/`extraction_running` → processing ;
   `ocr_failed`/`rejected`/`halted_missing_context` → failed ; libellés FR complets (aucun
   code brut ne peut plus atteindre l'opérateur).
3. **Ordre au save (`ReviewScreen`)** : le confirm partait EN PARALLÈLE des overrides — il
   pouvait affirmer « revue faite » avant que les corrections n'arrivent. Séquencé :
   overrides → confirm → drain (toujours fire-and-forget global, le save local ne bloque pas).
4. **Fuite AsyncStorage — outbox sans purge** : les ops `succeeded` restaient pour toujours
   (un lot par scan). `purgeTerminalOps` (succeeded >1 j, dead_letter >14 j, pending jamais
   touché) appelé en fin de drain + **re-passe traînante** du drain (un enqueue pendant un
   drain n'attend plus le prochain foreground) avec horloge fraîche par passe.

Vérifié : typecheck 0 + **146 jest** (+2 : machine 12 états, purge). Backend inchangé (239).
Reste à valider sur device (Phase 0.3) : clavier température Android (`numbers-and-punctuation`
est iOS-only → clavier complet en repli, signe moins requis pour −18 °C — choix actuel
délibéré, à revoir à l'essai terrain).

---

## 🔁 Refonte workflow v1 — capture enchaînée (5 juillet 2026)

Refonte complète du flux de scan : capture à la chaîne (envoi en arrière-plan dès le
déclencheur), file de scans visible sur l'accueil avec compteur 3 étapes, tous les champs
éditables (y compris GS1), photo en grand, §6.3 livré. Plan détaillé et vérifications :
`docs/mobile/MOBILE-APP.md` (référence vivante du flux et de l'architecture ScanQueue).

**Décisions produit actées.** ① Enchaînement direct après le déclencheur (flash + haptique +
pile de vignettes, pas de modale de revue par photo). ② Les 17 champs éditables, y compris
GS1 (lot/DLC/GTIN/poids/date emballage) — le serveur accepte l'override GS1 sous flag
explicite `force_gs1`, append-only, audité (voir Fix 4.2 ci-dessus). ③ Stepper 3 étapes par
carte en attente sur l'accueil : Photo envoyée → Extraction → À valider ; tap → revue ;
validé → la carte rejoint la liste normale.

**Backend (1 commit).** `force_gs1` sur `PATCH /v1/ingestions/{id}/fields/{name}` :
`override_field.py` (flag, action d'audit dédiée `ingestion.gs1_field_overridden`),
`router.py` (`OverrideFieldRequest.force_gs1`), +3 tests (`test_field_override.py`),
`API-CONTRACTS.md`/`openapi.v1.yaml` à jour. 409 `FIELD_NOT_EDITABLE` inchangé sans le flag
(rétrocompatibilité totale). Vérifié : 242 passed (`run_local_proofs.sh`), import-linter 5/5.

**Mobile (4 commits).**
1. **File de scans** (`services/scanQueue.ts`) : singleton + `useSyncExternalStore` (même
   patron que `outbox.ts`), état persisté (une entrée par scan, photo durable
   `pending/<id>.jpg`), scheduler à 3 sondages (long-poll) concurrents max, pause/reprise
   sur `AppState`, réconciliation avec l'outbox au démarrage/foreground/après drain.
   `services/ingestionResult.ts` : cœur non-hook extrait de l'ancien `useIngestionResult`
   (supprimé, mort).
2. **Caméra enchaînée** : `takePhoto` devient terminal (capture → crop → `enqueueScan` →
   flash/haptique, prêt pour le tir suivant) ; suppression de l'écran de revue photo
   bloquant et de la branche legacy morte ; nouveau `ScanTray` (pile de vignettes + badge).
3. **Accueil** : zone « En cours (N) » en `ListHeaderComponent` (hauteur mesurée, pas
   hardcodée — `getItemLayout` reste exact) ; `PendingScanCard` + `ScanStepper` +
   `services/scanSteps.ts` (mapping pur statut+ocrDone → 3 étapes) ; navigation Review
   par `pendingScanId` uniquement (dispatcher Legacy/Backend supprimé — un seul chemin).
4. **Revue** : entrée par la file (`useScan`), tous champs éditables (`fieldOverrideSubmit.ts`
   tague `force_gs1` sur les champs GS1 au lieu de les sauter), `PhotoViewerModal` (pinch/pan/
   double-tap, aucune dépendance nouvelle), carte photo cover arrondie (§6.3) en Revue et
   Détail article, `completeScan()` au save (la carte quitte la zone en cours).

**Vérifié** : typecheck 0 erreur, **170 jest verts** (+24 : `scanQueue` 13, `ingestionResult` 4,
`scanSteps` 7). Backend 242 passed + import-linter 5/5.

**Reste (checklist device, app lancée) :** tir enchaîné 5 photos <15 s ; kill pendant
extraction → relance → cartes restaurées ; mode avion → drain au retour réseau ; serveur down
→ carte erreur + Réessayer/Supprimer ; édition d'un champ GS1 → vérifier le run `source='human'`
+ l'action d'audit `gs1_field_overridden` côté serveur ; visionneuse pinch/pan/double-tap iOS
ET Android (reanimated 4, point de vigilance) ; carte cover arrondie jugée à l'œil ; clavier
température Android (reliquat passe santé, inchangé).

---

## 🔁 Refonte workflow v2 — verrou 17/17 + brouillon persistant + photo cuite (5 juillet 2026)

Suite de la v1. Décisions produit actées avec l'utilisateur : ① on **garde l'empilement** de
plusieurs arrivages « en cours » (file `scanQueue` inchangée), mais **un scan reste « en cours »
tant qu'il n'est pas validé à 17/17** — il n'est **jamais** un article avant ça. ② L'enregistrement
n'est **possible qu'à 17/17** ; en dessous, les modifications sont **sauvegardées** (brouillon
persistant = « session ») mais l'arrivage n'est pas compté. ③ La **rotation photo est cuite dans le
fichier** à la capture (fini la rotation d'affichage). ④ Le déclencheur **touches volume +/-** est
fiabilisé. ⑤ Revue nettoyée : plus d'**icône agrandir** ni de **retour flottant en haut**.

**Mobile (aucun changement backend).**
1. **Verrou 17/17 + session** : `PendingScan.edits` + `saveScanEdits(id, edits)` (`scanQueue.ts`,
   persisté/ré-hydraté) ; `ReviewScreen` seede le brouillon depuis `scan.edits`, le ré-écrit une fois
   au départ (effet unmount), et **verrouille « Enregistrer l'arrivage » sur `filledCount === 17`**
   (label « Compléter (n/17) » sinon). Compteur sur **valeurs effectives** via nouveau
   `filledCountFromValues` (`fieldCompleteness.ts`). `PendingScanCard` : « À compléter » (bleu) vs
   « À valider » (vert) selon 17/17.
2. **Photo cuite** : action `rotate: -90` en fin de pipeline `ImageManipulator` (`CameraScreen`) ;
   `RotatedPhoto` **supprimé** ; Revue/Détail/visionneuse en `Image`/`contain` standard (retrait du
   `rotate` de base dans `PhotoViewerModal`). Caveat legacy : photos pré-v2 non pivotées → portrait.
3. **Volume shutter fiabilisé** (`volumeShutter.ts`) : détection de l'**écho du reseat par la valeur**
   de volume (kill de la boucle), **debounce** d'un appui multi-pas, garde temporelle en repli,
   symétrie +/−. Module natif présent → OK après **dev-client rebuild** (non testable en jest).
4. **Nettoyage Revue** : retrait de l'icône `arrow-expand` + du back flottant haut (le tap photo
   ouvre toujours la visionneuse ; retour = bouton bas). `ArticleDetail` inchangé.

**Passe audit prod capture (même jour, suite v2).** 4 correctifs :
① **Zéro cliché perdu** : échec du pipeline d'arrière-plan (copie durable impossible) → repli
`enqueueScan` avec l'uri de capture d'origine (dégradé mais visible à l'accueil, jamais silencieux) ;
log `fallback=raw_cache`. ② **Double goBack au save** : `completeScan` retirait le scan pendant
l'`await` → le garde-fou `!scan → goBack` tirait EN PLUS du goBack du save ; `closingRef` armé avant
`completeScan` (ré-armé au catch). ③ **Jauge accueil vivante** : les fonctions de
`fieldCompleteness.ts` prennent un `edits` optionnel (overlay du brouillon, dans les deux sens) —
la carte `n/17` avance au fil de la session de saisie, `nameKnown` suit aussi. ④ **Suppression
d'une carte non-erreur** : corbeille discrète sur les cartes extracting/ready (« à compléter » ou
« à valider ») avec confirmation (mention du brouillon perdu s'il existe).

**Vérifié** : typecheck 0 erreur, **187 jest verts** (+17 vs v1 : `filledCountFromValues`,
`saveScanEdits` persistance/ré-hydratation, overlay `edits` run/interim/nameKnown). Backend inchangé.

**Reste (checklist device, app lancée) :** photo à l'endroit partout (revue/détail/vignette/
visionneuse) + photos legacy en portrait tolérées ; brouillon partiel restauré après aller-retour ;
bouton « Compléter (n/17) » désactivé jusqu'à 17/17 puis « Enregistrer l'arrivage » → article compté ;
**Volume+ ET Volume−** prennent une photo de façon fiable (un appui = un tir, pas de boucle, HUD
masqué) après rebuild natif.
