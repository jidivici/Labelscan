# LabelScan — Application mobile (Expo / React Native)

**Statut :** Implémenté. Client mince Expo (SDK 54) ; l'extraction « lourde » (OCR + LLM) vit côté
serveur. Ce document est la **référence du front mobile** — les docs `docs/` étant historiquement
côté backend, celui-ci comble le manque.
**Date :** 2026-07-05 (refonte workflow v2 — verrou 17/17, brouillon persistant, photo cuite).
**Périmètre :** `src/` uniquement.

> **À lire en regard :**
> - [`../backend/API-CONTRACTS.md`](../backend/API-CONTRACTS.md) — les endpoints que le client appelle.
> - [`../ai-pipeline/AI-PIPELINE.md`](../ai-pipeline/AI-PIPELINE.md) — OCR + extraction côté serveur.
> - [`../extraction/PROMPT-CONTRACT.md`](../extraction/PROMPT-CONTRACT.md) — le gate anti-fabrication.
> - `CLAUDE.md` (racine) — roadmap et backlog vivants.

---

## 1. Vue d'ensemble

- **Auth** : JWT par appareil (`POST /v1/auth/login`), token attaché en `Authorization: Bearer`
  ([`services/auth.ts`](../../src/services/auth.ts), [`services/api.ts`](../../src/services/api.ts)).
  Toute l'app est derrière l'écran de connexion ([`context/AuthContext.tsx`](../../src/context/AuthContext.tsx)).
- **Extraction backend uniquement.** L'ancien chemin OCR sur l'appareil (Google Vision côté client)
  a été retiré pour des raisons de sécurité (une clé `EXPO_PUBLIC_*` est extractible de tout build) —
  voir l'ADR historique dans `CLAUDE.md` §P0. Le flux est : recadrage au cadre → capture enchaînée
  (file de scans) → `POST /v1/ingestions` → extraction asynchrone (worker) → écran de vérification
  éditable → enregistrement local de l'article.
- **Contrat d'extraction v2 — 17 champs** (prompt v2.0.0) : `commercial_designation`,
  `scientific_name`, `producer_name`, `reseller_brand`, `production_method`,
  `fishing_gear_or_farming_method`, `FAO_area`, `origin_country`, `health_mark`, `batch_number`,
  `expiry_date`, `packaging_date`, `storage_temperature`, `weight`, `allergens`, `price`, `gtin`
  ([`services/fieldOrder.ts`](../../src/services/fieldOrder.ts) — ordre HACCP partagé Revue ⇄ Détail).
- **Stockage local** : articles sauvegardés en AsyncStorage indexé par clé
  ([`services/storage.ts`](../../src/services/storage.ts)), file d'attente de transport (outbox,
  [`services/outbox.ts`](../../src/services/outbox.ts)) et file de scans en cours (scan queue,
  [`services/scanQueue.ts`](../../src/services/scanQueue.ts) — voir §3).

---

## 2. Nouveau flux — capture enchaînée (workflow v1)

**Une pile racine unique** ([`navigation/RootNavigator.tsx`](../../src/navigation/RootNavigator.tsx)) :
`ArticleList` (accueil) · `ArticleDetail` · `Camera` · `Review`. La capture se lance à la demande via
un **FAB** en bas-droite de la liste ([`components/CaptureFab.tsx`](../../src/components/CaptureFab.tsx)).

```
ArticleList ──(FAB)──▶ Camera ──(tir)──▶ enqueueScan() (arrière-plan) ──▶ tir suivant…
     ▲                                              │
     │                                     scanQueue : submitting → extracting → ready
     │                                              │
     └────(tap sur une carte « ready » à l'accueil)──▶ Review ──(Enregistrer)──▶ ArticleList
```

- **Le déclencheur envoie, l'opérateur reste sur la caméra.** Chaque photo prise est recadrée
  (identique à avant) puis **immédiatement mise en file** (`enqueueScan`, flash + haptique de
  confirmation) — pas d'écran de revue bloquant, pas de bouton Valider par photo. L'opérateur
  peut enchaîner N photos ; le serveur accepte les soumissions concurrentes (idempotentes,
  dédupliquées par hash de contenu).
- **`ScanTray`** ([`components/ScanTray.tsx`](../../src/components/ScanTray.tsx)) : sur l'écran
  caméra, une pile de vignettes + compteur + point pulsant tant qu'au moins un scan est
  `submitting`/`extracting`. Tap → retour à l'accueil. La caméra reste un **viseur pur** : les
  erreurs se lisent à l'accueil, jamais ici.
- **Accueil — zone « En cours »** : chaque scan en file est une carte avec un **compteur 3 étapes**
  (Photo envoyée → Extraction → À valider). Tap sur une carte `ready` → ouvre `Review`. Une fois
  l'arrivage enregistré, la carte quitte la zone « En cours » et rejoint la liste normale (§4).
- **Ressource caméra** : `CameraView` n'est montée que lorsque l'écran Camera est **focalisé**
  (`useIsFocused`), relâchée au retour Articles — `expo-camera` n'autorise qu'**un** aperçu actif
  à la fois.

### Recadrage & fidélité (capture)

Le **cadre à l'écran est à la fois le guide de placement ET la région de recadrage**
([`screens/CameraScreen.tsx`](../../src/screens/CameraScreen.tsx),
[`components/FrameOverlay.tsx`](../../src/components/FrameOverlay.tsx)).

- **Couverture** : le cadre fait **≈96 % de la largeur** et occupe la quasi-totalité de la zone
  utile, pour placer **l'étiquette entière** dedans.
- **Marge de sécurité** : `computeFrameCrop` élargit le rectangle de **8 % par axe** avant d'inverser
  la transformation d'affichage « cover », puis **borne** dans les pixels de la photo (jamais hors
  limites).
- **Fidélité** : `takePictureAsync({ quality: 1.0 })` + recadrage borné à **≤1600 px** sur le grand
  côté, `compress: 0.8` (Tier 7 — l'OCR est co-dominant sur un upload lent ; image plus petite =
  upload et OCR plus rapides sans perte de lisibilité).
- **Robustesse** : `skipProcessing: false` applique la rotation capteur ; si l'image revient
  transposée ou le rectangle est dégénéré, on **envoie l'image entière** (repli sans perte).
- **Zéro cliché perdu (audit prod v2)** : si le pipeline d'arrière-plan échoue (copie durable
  impossible — disque plein…), un **repli last-ditch** met quand même le scan en file avec l'uri de
  capture d'origine (non recadrée/pivotée, dégradé mais récupérable) — l'opérateur voit toujours une
  carte à l'accueil, jamais une photo évaporée. Log `capture … fallback=raw_cache`.
- **Côté serveur** : aucun sous-échantillonnage (l'image envoyée par le client est prise telle
  quelle) — voir [`AI-PIPELINE.md`](../ai-pipeline/AI-PIPELINE.md) §2.5.

---

## 3. Architecture de la file de scans (`scanQueue.ts`)

Le cœur de la refonte : un **module singleton** (pattern déjà utilisé par `outbox.ts`), consommé
par les écrans via `useSyncExternalStore` ([`hooks/useScanQueue.ts`](../../src/hooks/useScanQueue.ts)).
Aucun écran ne possède plus le cycle de vie d'une extraction — la file le fait, qu'un écran soit
monté ou non.

**Frontière avec l'outbox** : l'**outbox reste le transport durable** (retry, backoff, dead_letter,
clés d'idempotence — inchangé). La **scan queue est l'état de workflow UI** (quel scan, quelle
étape, quelle photo) ; elle référence les opérations outbox par id et ne duplique jamais leur logique
de retry — ses propres reprises sont soit une nouvelle opération (`retryScan` sur `submit_error`),
soit un nouveau cycle de sondage (`retryScan` sur `extract_error`).

- **Modèle persisté** (`@labelscan:scanQueue`, une entrée par scan) : id local, photo **durable**
  (`documentDirectory/pending/<id>.jpg` — copiée depuis le cache de recadrage, qui peut être purgé
  avant la revue), code-barres, id d'ingestion, statut (`submitting` / `extracting` / `ready` /
  `submit_error` / `extract_error`), indicateur `ocrDone` (vague 2 déterministe, Tier 3). Les
  résultats (ingestion + run) restent **en mémoire uniquement** — re-récupérés en un `GET` au
  redémarrage (`latest_fields` embarqué rend ça gratuit ; le serveur est la vérité).
- **`ingestionResult.ts`** ([`services/ingestionResult.ts`](../../src/services/ingestionResult.ts)) :
  cœur non-hook de l'ancien `useIngestionResult` — `waitForIngestionResult(ingestionId, opts)`
  poll → `latest_fields` (chemin rapide) → repli `getExtractionRun` (vieux serveur), callback
  `onInterim` pour la vague 2 (Tier 3). `ingestionPolling.ts` (long-poll Tier 4) est inchangé.
- **Scheduler** : cap de **3 sondages (long-poll) concurrents**, le reste attend en FIFO (le
  long-poll Tier 4 découvre les transitions en ~0 ms, une extraction dure ~10-20 s → la file se
  vide vite). Un `AbortController` par scan ; pause de tous les sondages au passage en arrière-plan
  (`AppState`), reprise + réconciliation au premier plan. Budget de ~5 min par scan avant
  `extract_error` (repris manuellement depuis l'accueil — l'extraction serveur continue de toute
  façon).
- **Réconciliation** (`reconcileScanQueue`, appelée au démarrage, au premier plan, et après chaque
  drain outbox réussi) : un scan `submitting` relit son opération outbox (`succeeded` → passe
  `extracting` + lance le sondage ; `dead_letter` → `submit_error` ; opération introuvable →
  `submit_error`). Un scan `extracting`/`ready` sans résultat en mémoire relance un sondage.
- **Dédoublonnage** : si la soumission revient `replayed: true` sur un `ingestionId` déjà actif
  dans la file, la nouvelle entrée (et sa photo) est supprimée silencieusement.
- **Cycle de vie des photos** : dossier `pending/` dédié, balayé au démarrage pour supprimer les
  fichiers orphelins (crash entre la copie et l'écriture de la file).

---

## 4. Accueil : compteur 3 étapes et validation

> **Workflow v2 — un scan « en cours » n'est JAMAIS un article.** Chaque scan reste dans la zone
> « En cours » tant que ses **17 champs ne sont pas tous remplis** ; il n'entre dans la liste des
> articles (et n'incrémente le comptage) qu'à l'**enregistrement 17/17** (§5). Plusieurs scans
> peuvent coexister « en cours » (empilement inchangé). Sur la carte, quand un scan est `ready`
> mais `< 17/17`, l'étape 3 lit **« À compléter »** (bleu) au lieu de « À valider » (vert) —
> `PendingScanCard` compare `filledCount` à `CANONICAL_FIELD_COUNT`.
>
> **Jauge vivante** : le score `n/17` de la carte est calculé run/interim **+ overlay du brouillon
> persistant** (`scan.edits`) — les fonctions de `fieldCompleteness.ts` prennent un paramètre
> `edits` optionnel qui prime dans les deux sens (une saisie remplit, un champ vidé dé-remplit).
> La jauge avance donc à chaque retour de revue, au fil de la session de saisie.
>
> **Suppression uniforme (v2.1) = swipe gauche.** Chaque carte « En cours » se supprime par un
> **glissement vers la gauche révélant Supprimer** — exactement le même geste que les fiches
> articles (`ArticleCard` : Pan gesture, seuil −60, révélateur rouge 80 px). Actif sur TOUS les
> états (une photo ratée se supprime même pendant l'extraction) ; confirmation systématique, le
> message signale la perte du brouillon s'il existe. Les cartes en erreur gardent le bouton
> « Réessayer » ; leur suppression passe aussi par le swipe.

- **`scanSteps.ts`** ([`services/scanSteps.ts`](../../src/services/scanSteps.ts)) : mapping **pur**
  `scanStepFromStatus(status, ocrDone)` → 3 étapes (Photo envoyée / Extraction / À valider) +
  libellé de l'étape active. Sobre par construction (Clean UI) : pas de pourcentage, pas de
  confiance — une étape est faite / active / en attente / en erreur.
- **`ScanStepper.tsx`** : même langage visuel que `ExtractionProgress` (PulseDot sur l'étape active,
  check animé sur une étape faite), en ligne horizontale compacte (vit dans une carte de liste).
- **`PendingScanCard.tsx`** : vignette photo + stepper, ou — en cas d'erreur — libellé + boutons
  **Réessayer** / **Supprimer** (avec confirmation). Hauteur **fixe** (`PENDING_CARD_HEIGHT`) pour
  que `getItemLayout` de la `FlatList` des articles reste exact malgré la zone « En cours » en
  `ListHeaderComponent` (la hauteur du header est **mesurée** via `onLayout`, jamais devinée).
- **Ouverture de la revue** : `navigation.navigate('Review', { pendingScanId })` — `Review` ne lit
  plus rien depuis les paramètres de navigation à part cet id ; photo, code-barres, résultat
  d'extraction sont lus **en direct** depuis la file (`useScan`, §5).

---

## 5. Revue — tous les champs éditables, visionneuse, carte photo

- **Entrée par la file** : `ReviewScreen` lit `useScan(pendingScanId)` — si le scan est encore
  `extracting`, l'UI de chargement existante s'affiche telle quelle (skeletons `FIELD_ORDER` +
  `ExtractionProgress` + `CascadeReveal`, vague GS1 → vague 2 déterministe → LLM) ; si déjà `ready`,
  tout s'affiche directement, sans saut. Si le scan a disparu de la file pendant que l'écran était
  ouvert (validé/supprimé ailleurs), retour silencieux à l'accueil.
- **Les 17 champs sont éditables**, y compris les champs issus du code-barres (GS1 : lot, DLC,
  poids, GTIN, date d'emballage). Au save, `submitFieldOverrides` tague automatiquement l'override
  d'un champ GS1 avec `force_gs1` — le serveur l'accepte alors sous une action d'audit dédiée
  (`ingestion.gs1_field_overridden`, append-only, jamais un écrasement — voir
  [`API-CONTRACTS.md`](../backend/API-CONTRACTS.md) §3). Sans le flag, le champ reste 409
  `FIELD_NOT_EDITABLE` (rétrocompatibilité totale avec un serveur non redéployé).
- **Verrou 17/17 (workflow v2)** : « Enregistrer l'arrivage » n'est **actif qu'à 17/17**. Le
  compteur de complétude est calculé sur les **valeurs effectives** (brouillon prioritaire sur la
  valeur extraite) via `filledCountFromValues` ([`services/fieldCompleteness.ts`](../../src/services/fieldCompleteness.ts)) —
  même map que celle affichée, donc zéro divergence compteur ⇄ écran. En dessous, le bouton lit
  **« Compléter (n/17) »** (désactivé).
- **Brouillon persistant (« session »)** : l'état d'édition est **seedé depuis `scan.edits`** et
  **ré-écrit une seule fois** au départ de l'écran (`saveScanEdits`, effet de nettoyage sur unmount).
  Quitter puis rouvrir une revue partielle **restaure les modifications** ; le scan reste « en cours »
  tant qu'il n'est pas validé à 17/17. `saveScanEdits` est un no-op si le scan a été validé/supprimé.
- **Visionneuse plein écran** (`PhotoViewerModal.tsx`) : pinch-to-zoom (bornes ×1–5), pan, double-tap
  pour zoomer/dézoomer, fermeture par bouton. Aucune dépendance nouvelle (`react-native-gesture-handler`
  + `react-native-reanimated` déjà utilisés par `ArticleCard`) ; le `Modal` RN a sa propre racine
  native, donc la visionneuse embarque son propre `GestureHandlerRootView`.
- **Photo cuite à l'endroit (workflow v2)** : la rotation −90° est désormais **cuite dans le fichier**
  à la capture (`ImageManipulator`, action `rotate: -90` en fin de pipeline dans `CameraScreen`), au
  lieu d'une rotation d'affichage. Le composant `RotatedPhoto` est **supprimé** ; Revue, Détail
  article, vignette « En cours » et visionneuse affichent tous un `Image`/`contain` standard (plus de
  double rotation). **Caveat** : les articles enregistrés AVANT ce changement (données de test
  pré-prod) ont un fichier non pivoté → ils s'affichent en portrait ; un re-scan corrige.
- **Nettoyage Revue** : l'**icône agrandir** et le **bouton retour flottant en haut** sont retirés de
  `ReviewScreen` (le tap sur la photo ouvre toujours la visionneuse ; le retour se fait par le bouton
  « Retour » de la barre d'action du bas). `ArticleDetailScreen` conserve son icône d'agrandissement.
- **Au save** : chemin inchangé (`saveBackendArticle` local → overrides → `confirm` → drain), puis
  `completeScan(scanId)` retire l'entrée de la file (et sa photo `pending/`) — la carte quitte la
  zone « En cours » et l'article apparaît dans la liste (comptage à jour).

---

## 6. Suggestions d'allergènes — aide à la décision, **pas** de l'extraction

[`services/allergenSuggestions.ts`](../../src/services/allergenSuggestions.ts) +
[`screens/ReviewScreen.tsx`](../../src/screens/ReviewScreen.tsx).

`suggestAllergen(fields)` dérive **déterministiquement** une famille de l'**Annexe II UE**
(`Poisson` / `Crustacés` / `Mollusques`) à partir de `scientific_name` / `commercial_designation`.
Règles de conformité :

- **Suggestion, jamais auto-application.** Le chip n'apparaît que sur le champ `allergens` et que s'il
  est **vide**. L'accepter écrit une **valeur humaine** (`source='human'` à l'enregistrement), jamais
  une valeur « extraite ». Les allergènes **déclarés sur l'étiquette priment**.
- **Jamais de devinette.** Mélange ambigu (« fruits de mer ») ou espèce inconnue ⇒ `null` (pas de chip).
- **Pas de provenance/FAO déduits** : interdit par le PROMPT-CONTRACT. Le gate anti-fabrication de
  l'extraction est **inchangé**.

Couvert par [`__tests__/allergenSuggestions.test.ts`](../../src/__tests__/allergenSuggestions.test.ts).

### Autocomplétion par champ depuis l'historique (v2.1)

[`services/fieldHistory.ts`](../../src/services/fieldHistory.ts) — les valeurs **récurrentes**
d'une criée (espèces, producteurs, zones FAO, marques sanitaires…) se resaisissent en un tap :

- **Source = les articles enregistrés** (`getAllArticles`, vérité validée par un humain) — jamais
  une valeur machine ni calculée. Index construit au mount de la revue (`buildFieldHistory`) :
  dédup par forme normalisée (accents/casse — `normalize` partagé avec l'omni-recherche), casse de
  l'occurrence la plus récente, tri **fréquence puis récence**.
- **9 champs concernés** (`HISTORY_FIELDS`) : désignation commerciale, nom scientifique,
  producteur, marque revendeur, méthode de production, engin/méthode d'élevage, zone FAO, pays
  d'origine, marque sanitaire. **Exclus** : lot/dates/GTIN (uniques par arrivage), poids/temp/prix
  (inputs à affixe), allergènes (suggestion conformité Annexe II dédiée, inchangée).
- **UX** : jusqu'à 3 **chips neutres** (icône horloge) sous le champ, uniquement quand il est
  **focalisé** ; champ vide → top 3, sinon complétion **préfixe puis substring** ; la valeur déjà
  saisie n'est jamais re-suggérée. Tap → remplit le champ = **édition humaine** (même chemin que la
  frappe ; gate anti-fabrication intact). Couvert par
  [`__tests__/fieldHistory.test.ts`](../../src/__tests__/fieldHistory.test.ts).

### Aide à la saisie des dates (`expiry_date` / `packaging_date`)

Clavier numérique (`number-pad`) + masque **DD/MM/YYYY** (insertion auto du `/`) —
[`services/inputMasks.ts`](../../src/services/inputMasks.ts). C'est une **aide à la saisie**, pas
une valeur calculée : **pas** d'« expiry = packaging + N jours ». Dates stockées **canonique ISO**
(`toIsoDate`), affichées DD/MM/YYYY ; validation neutre et non bloquante (jamais de rouge).

### Estampille sanitaire (`health_mark`) — toujours en majuscules

Le cachet officiel UE est imprimé en majuscules (ex. `FR 34.108.504 CE`, `GB BB004`) —
[`services/inputMasks.ts`](../../src/services/inputMasks.ts) : `maskHealthMark` force chaque
frappe en majuscule **sans jamais retirer un caractère** (espaces/points/tirets du format
d'origine conservés — no-fabrication). `validateHealthMark` ajoute un indice neutre, non
bloquant, si une valeur qui semble complète (≥3 caractères) ne contient **aucun chiffre** (le
numéro d'établissement est toujours présent sur un vrai cachet). Portée volontairement limitée
à la **saisie de l'opérateur** : une valeur extraite par l'IA non modifiée n'est jamais
retouchée côté client (garde l'invariant « valeur affichée == valeur persistée »).

### Libellés FR + saisie par unité

- **Libellés métier** : [`services/fieldLabels.ts`](../../src/services/fieldLabels.ts)
  (`batch_number` → « N° de lot », `FAO_area` → « Zone de pêche (FAO) »…).
- **Poids** : champ numérique + affixe d'unité **kg ⇄ g** (tap), aucune conversion automatique.
- **Température de conservation** : deux champs **[min] – [max] °C**.
- **Prix** : clavier décimal + affixe devise (€ par défaut).
- **Omni-recherche** (liste Articles) : filtre sur tous les champs + code-barres, insensible aux
  accents/casse — [`hooks/useArticleSearch.ts`](../../src/hooks/useArticleSearch.ts) /
  [`services/articleSearch.ts`](../../src/services/articleSearch.ts).
- **Zone FAO (avec sous-zone)** : captée verbatim par l'extraction backend, mise en forme à
  l'affichage par `formatFaoDisplay` — valeur brute conservée, jamais tronquée.

---

## 7. Configuration (variables d'environnement Expo)

| Variable | Rôle | Défaut |
|---|---|---|
| `EXPO_PUBLIC_API_BASE_URL` | Base URL du backend | vide → l'API lève une erreur claire |

L'extraction est **backend uniquement** — aucune clé tierce n'est embarquée dans le bundle mobile.
(L'ancienne variable `EXPO_PUBLIC_GOOGLE_VISION_KEY`, liée au chemin OCR sur l'appareil, a été
retirée avec ce chemin — audit §7.3.)

---

## 8. Carte du code (`src/`)

- **`navigation/`** — `RootNavigator` (pile unique ; `Review` ne prend plus qu'un `pendingScanId`).
- **`screens/`** — `ArticleList` (accueil, FAB, export, zone « En cours »), `ArticleDetail`, `Camera`
  (viseur + capture enchaînée + `ScanTray`), `Review` (entrée par la file, tous champs éditables),
  `Login`.
- **`components/`** — `CaptureFab`, `FrameOverlay`, `CaptureButton`, `FlashOverlay`, `ArticleCard`,
  `EmptyState`, `ScanTray`, `PendingScanCard`, `ScanStepper`, `PhotoViewerModal`, `ExtractionProgress`,
  `CascadeReveal`, `PulseDot`, `SkeletonFieldList`.
- **`services/`** — I/O : `api`, `auth`/`authStorage`, `ingestionSubmit`, `ingestionResult`,
  `ingestionPolling`, `scanQueue`, `storage`, `outbox`, `outboxDrain`, `export`,
  `fieldOverrideSubmit`. Helpers **purs** (testables) : `dates`, `inputMasks`, `fieldLabels`,
  `fieldOrder`, `scanSteps`, `extractionStage`, `allergenSuggestions`, `articleSearch`,
  `articleGrouping`, `gs1`, `faoDisplay`.
- **`hooks/`** — `useArticleSearch`, `useScanQueue` (`useScanQueue`/`useScan`).
- **`types/`** — `api.ts` (miroir des contrats backend), `Article.ts`.
- **`theme/`** — tokens Material You (couleurs, espacements, typographie, élévation).

---

## 9. Tests

`npx jest --config jest.config.js` (ts-jest, environnement node) — 21 suites, **199 tests** ;
notables : `scanQueue` (transitions, cap de sondages, hydratation/réconciliation, dédoublonnage,
nettoyage photo, **`saveScanEdits` persiste + ré-hydrate le brouillon**), `ingestionResult`,
`scanSteps` (mapping 5 statuts × `ocrDone`), `fieldCompleteness` (**`filledCountFromValues` = verrou
17/17**), `fieldOverrideSubmit` (force_gs1). Vérification de types : `npx tsc --noEmit`.

---

## 10. Liens

- [`../backend/API-CONTRACTS.md`](../backend/API-CONTRACTS.md), [`../ai-pipeline/AI-PIPELINE.md`](../ai-pipeline/AI-PIPELINE.md).
- `CLAUDE.md` (racine) — roadmap et backlog vivants.
- [`../archive/README.md`](../archive/README.md) — synthèses et audits de chantiers clos.
