# claude.md — Architecture Frontend, Refonte UI, Search & Haiku Prompting
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

### 🔜 Moyen terme (gardé en mémoire — backlog priorisé)
- [ ] **§1.3 Double aller-retour** : endpoint léger `GET /v1/ingestions/{id}/status` (juste
  `{status}`) pour le poll + champs du dernier run embarqués sur l'état terminal. `src/hooks/useIngestionResult.ts`
- [ ] **§2.1/2.2 Cascade par champ + zéro layout shift** : seeder les lignes GS1
  (lot/DLC/poids/GTIN) dans la liste éditable dès T+0, skeleton ciblé uniquement sur les
  champs LLM, `SkeletonFieldList count` aligné sur le set connu. `src/screens/ReviewScreen.tsx`
- [ ] **§7.1 Re-renders** : `React.memo(EditableFieldRow)` + callbacks stables ;
  `React.memo(ArticleCard)` + `renderItem` stable + props FlatList (`initialNumToRender`,
  `windowSize`, `removeClippedSubviews`).
- [ ] **§1.5 Débit worker** : `deploy.replicas: 2-3` (`SKIP LOCKED` déjà multi-worker), puis
  OCR/LLM concurrents entre ingestions. `docker-compose.yml`
- [ ] **§6.3 Photo** : trancher `cover` vs `contain` (directive §2 vs implémentation actuelle
  `contain`), uniformiser + coins arrondis sur Review et Détail.

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
