# Revue de latence + livraison — session 21 juin 2026

> ⚠️ **MàJ 21 juin (soir) — mesures client en main (§0).** Les durées *par étape* du §2 restent
> des **estimations** (Vision/Haiku), mais le **bout-en-bout est désormais mesuré** (instrumentation
> §6 livrée, `4d426a3`). Verdict : la réalité est **2–3× pire** que l'estimation. Le split
> `ocr_ms`/`llm_ms` côté worker était **invisible à cause d'un bug** : le `JsonFormatter`
> (allow-list) **droppait** ces clés — l'event `extraction_timing` se loggait sans ses chiffres,
> worker pourtant à jour. **Corrigé** (`observability.py`) ; rebuild worker + rescan pour le capturer.

## 0. Mesures réelles — client, 3 scans, mode backend (`replayed=false`)

| Scan | `upload_ms` | `wait_ms` (Valider → champs) | post-upload (`wait − upload`) |
|------|-------------|------------------------------|-------------------------------|
| 1 | 6091 | 20517 | 14426 |
| 2 | 6407 | 19495 | 13088 |
| 3 | 6758 | 21114 | 14356 |
| **moy.** | **~6,4 s** | **~20,4 s** | **~14,0 s** |

**Lecture.**
- **Total perçu ≈ 20 s** — l'estimation §2 (« 3–9 s ») était **trop optimiste de 2–7×**. La latence
  est un **vrai problème**, pas une impression : l'opérateur fixe bien ~20 s de skeletons.
- **Upload ≈ 6,4 s** vs 0,3–2 s estimé : **anomalie n°1**. Suspect principal historique, le *fallback plein
  format* — avant la correction des buffers transposés, si `computeFrameCrop` renvoyait `null`,
  **aucun resize n'est appliqué** → on téléverse le JPEG `quality:1.0` 12 Mpx (~4–8 Mo) au lieu de
  ~300–600 Ko. À confirmer en logguant `bytes`/`cropped` (§6). Second suspect : backend joint via
  tunnel Expo / réseau lent.
- **Post-upload ≈ 14 s** (pickup + OCR + LLM + gate + persist + détection) vs 2–6 s estimé pour
  OCR+LLM : **anomalie n°2**. `replayed=false` ⇒ **vrai temps provider** (pas un dedup).
  **Inattribuable sans le split `ocr_ms`/`llm_ms`** — la mesure worker manquante.
- **Action immédiate** : `docker compose up -d --build` (worker) puis `docker compose logs -f
  worker | grep extraction_timing` → savoir si les 14 s sont OCR, LLM, ou un lag caché.

### Après Tier 1 (soumission spéculative), même appareil — `speculative=true` ×3

| Scan | `upload_ms` | `wait_ms` (depuis Valider) |
|------|-------------|----------------------------|
| 1 | 1770 | 12931 |
| 2 | 3376 | 15721 |
| 3 | 2272 | 17170 |
| **moy.** | **~2,5 s** | **~15,3 s** |

- **`wait_ms` 20,4 → 15,3 s (−25 %)** : l'upload est désormais **recouvert** par la revue photo et
  ne compte plus dans l'attente perçue. `speculative=true` ⇒ Tier 1 gagne à chaque scan.
- **Le résidu ~15 s reste dominé par l'extraction OCR+LLM (~14 s).** La pause de revue photo est
  **trop courte** pour la recouvrir entièrement → Tier 1 masque surtout l'**upload**, pas les 14 s.
  Pour aller plus loin : (a) **réduire** ces 14 s (⇒ split `ocr_ms`/`llm_ms` **toujours pas
  capturé**, mesure n°1) ; (b) les **masquer** par la cascade Tier 3 + le bandeau Tier 5 (en place).
- `upload_ms` 6,4 → 2,5 s : à lire avec prudence (variance réseau / cold-start entre les deux
  séries) ; le log `bytes`/`cropped` trancherait sur le *fallback plein format*.

### 🎯 Split worker CAPTURÉ (21 juin, après fix formatter) — l'OCR est co-dominant

| extraction | `ocr_ms` | `llm_ms` | total provider |
|------------|----------|----------|----------------|
| 1 | 8100 | 8915 | 17,0 s |
| 2 | 7370 | 4832 | 12,2 s |
| 3 | 16311 | 8750 | 25,1 s |
| 4 | 17890 | 15678 | 33,6 s |
| **moy.** | **~12,4 s** | **~9,5 s** | **~21,9 s** |

**Diagnostic (le vrai, enfin mesuré).**
- **L'OCR est CO-DOMINANT, souvent > LLM** (7–18 s/appel Vision). L'estimation §2 (« OCR 0,6–2 s,
  dominant = LLM ») est **FAUSSE** — c'était l'hypothèse n°1 à corriger.
- **Pas de retry, cache prompt OK** (`cache_read_input_tokens=6365`, 0 création, `claude-haiku-4-5`)
  → vrais temps d'**appel unique**, pas un artefact retry/cache.
- **Images ~1,7 Mo** (≈2000 px/0,8 — le resize §1.4 fonctionne, ce **n'est PAS** le fallback plein
  format ; l'anomalie upload était de la variance).
- **OCR et LLM ralentissent ENSEMBLE** (events 3-4) → facteur commun = **l'egress réseau** du
  conteneur. Mesuré depuis le worker : **~600–800 ms/petit appel HTTPS** (DNS+TLS+RTT), **~0,5 Mo/s**.
  Uploader 1,7 Mo (≈2,3 Mo en base64) à Vision **par appel, sans réutilisation de connexion** =
  ~4–5 s rien que pour l'upload, avant même le traitement Vision.
- **⚠️ Probable ARTEFACT D'ENVIRONNEMENT** : Docker Desktop **macOS** a un egress lent/à forte
  latence. En **prod (Linux, egress datacenter)** ces appels seraient vraisemblablement **2–4×
  plus rapides**. **Avant d'optimiser l'app, remesurer depuis un environnement prod-like.**

**Leviers (révisés par la mesure).** (a) **Tier 7** — image plus petite vers Vision (≤1600 voire
≤1280 px, `compress` plus agressif ; tester le recall) : ~½ de l'upload OCR. (b) **Réutilisation de
connexion** httpx (Client persistant) côté OCR + LLM : −~600 ms/appel. (c) **Tier 6 OCR on-device** :
supprime carrément le hop serveur→Vision (le plus gros poste). (d) Le LLM (~9 s) reste à creuser une
fois l'egress neutralisé (prod-like) — cache OK, donc piste = génération/`max_tokens` + réseau.

### 🔄 Mesure 3 (après ≤1600px + log `image_bytes`) — l'OCR était NETWORK-bound, pas size-bound

| `ocr_ms` | `llm_ms` | `image_bytes` |
|----------|----------|----------------|
| 2761 | 7870 | 1,82 Mo |
| 1414 | 7760 | 1,44 Mo |
| 2187 | 7280 | 1,55 Mo |
| 3410 | 5421 | 1,29 Mo |
| 1569 | 7276 | 1,69 Mo |
| 1473 | 6982 | 1,69 Mo |
| 618 | 3862 | 0,22 Mo |
| **moy.** | **~1,9 s** | **~6,6 s** | ~1,4 Mo |

**Ce que ça révèle (et corrige Mesure 2).**
- **OCR : ~12 s → ~2 s pour des images de MÊME taille (~1,7 Mo).** L'image n'a quasi pas bougé (le
  ≤1600px shrink peu : contenu + compression dominent), pourtant l'OCR s'effondre. ⇒ **l'OCR était
  NETWORK-bound (egress congestionné en Mesure 2), pas size-bound.** L'« OCR co-dominant » était un
  **artefact réseau**, pas une vérité structurelle.
- **Le LLM (~7 s) est maintenant le poste DOMINANT** (stable sur 7 scans, cache OK). C'est LA cible —
  si ça tient en prod-like. Piste : génération/`max_tokens`, sortie 16 champs, TTFT réseau.
- **Total ~9 s** (vs ~22 s congestionné) : la latence **swingue énormément avec l'état réseau** →
  re-confirme qu'il faut **mesurer en prod-like**, pas en Docker-macOS, avant d'investir.
- **≤1600px a peu réduit le fichier** (toujours 1,3–1,8 Mo) : pour vraiment shrinker → **≤1280px +
  `compress 0.7`** (tester le recall). Mais l'OCR étant network-bound, le gain réel est surtout sur
  **réseau lent** (assurance), pas sur réseau correct (OCR déjà ~2 s).

## 1. Features livrées cette session (audit)

| Commit | Périmètre | Vérifié |
|--------|-----------|---------|
| `4d426a3` | **Instrumentation latence (§6)** : client `latencyLog.ts` (`__DEV__`) → `upload_ms` + `wait_ms`/`status` ; worker `extraction_timing { ocr_ms, llm_ms }` | tsc + 128 jest ; ruff + import-linter 5/5 — **sortie worker pas encore capturée (rebuild requis)** |
| `ffdf890` | Quick wins (poll plat ~1s, badge caméra retiré, tag « À vérifier » retiré, upload compress 0.8/≤2000px, FAO verbatim, clavier prix) + **Fix 4.2** (PATCH `…/fields/{name}`, override append-only `source='human'`, garde GS1, mobile outbox) | pytest 5 + suite back verte, import-linter 5/5, tsc + jest |
| `3d01b65` | **Fix 7.2** : port `ArticleStore` + `InMemory`/`AsyncStorage` (1 clé/article → fin du plafond 6 Mo, O(1)), `raw_extraction_run` hors chemin chaud, migration legacy | tsc + 108 jest |
| `8405a00` | **Fix 5** : `PriceInput` (€), validateurs non bloquants date/temp/poids, dates ISO canoniques, faux « édité » corrigé | tsc + 122 jest |
| `a6d2f93` | **Batch A** : cascade par champ (liste stable 16 lignes T+0, GS1 préremplis, skeleton en place), `React.memo` rows | tsc + 125 jest |
| `e5909cb` | **Batch B** : `React.memo(ArticleCard)` + `getItemLayout`/FlatList tuning | tsc + jest |
| `d23f885` | **Batch D** : worker `replicas: 2` | `docker compose config` |
| `939e4a9` | **Batch C** : `latest_fields` embarqués → 1 aller-retour réseau en moins | suite back verte (PG) |

## 2. Décomposition du chargement hybride (waterfall)

Flux **mode backend**, du tap « Valider » à l'affichage des champs :

| # | Étape | Où | ~Durée | Optimisé cette session ? |
|---|-------|-----|--------|--------------------------|
| 1 | Tap Valider → roue « Envoi… » | `CameraScreen` / `ProcessingOverlay` | 0 | — |
| 2 | **Upload** image croppée (POST /v1/ingestions) | réseau ↑ | 0,3–2 s | ✅ compress 0.8/≤2000px |
| 3 | Nav → Review, **GS1 à T+0** (lot/DLC/poids dans la liste) | mobile | ~0 | ✅ cascade Batch A |
| 4 | **Pickup worker** (poll outbox 1 s) | `worker_runtime` | 0–1 s | ❌ |
| 5 | **OCR** (worker → Google Vision, image pleine résol., `DOCUMENT_TEXT_DETECTION`) | réseau serveur→Google | **0,6–2 s** | ❌ |
| 6 | **LLM** (worker → Haiku, prompt caché, 16 champs JSON) | réseau serveur→Anthropic | **1,5–4 s** | ❌ (cache prompt déjà ON) |
| 7 | Gate + réconciliation + persist | backend | 0,05–0,2 s | — |
| 8 | **Détection poll mobile** | `ingestionPolling` | 0–1 s | ✅ plat 1s (était 0–5 s) |
| 9 | Affichage des champs LLM (d'un coup) | `useIngestionResult` | ~0 | ✅ sans 2e fetch (§1.3) |

**Total estimé ≈ 3–9 s — INFIRMÉ par la mesure : réel ≈ 20 s (voir §0).** Le **cœur incompressible = étapes 5+6 (OCR+LLM) ≈ 2–6 s**, strictement séquentielles
et **après** le tap Valider.

## 3. Pourquoi la latence perçue n'a pas bougé

Mes correctifs ont rogné **l'attente morte** (étapes 4/8/9 : backoff de poll, 1 RTT) et l'**upload**
(étape 2). Ils n'ont **pas touché** les étapes 5+6, qui **dominent** (2–6 s). Ordre de grandeur :
avant ~8–10 s (5 s traitement + 3–5 s attente morte) → après ~5,5 s (5 s traitement + ~0,5 s
détection). C'est un **vrai −30 à −45 %**, mais l'opérateur fixe toujours ~5 s de skeletons → ça
ne se *sent* pas sans A/B. Trois aggravants possibles côté test :

1. **Backend pas relancé** : §1.3 (latest_fields) et 4.2 n'agissent que si `docker compose up` tourne sur ce code.
2. **Pas de barcode GS1** sur l'étiquette → aucune donnée à T+0 → tout attend le LLM (étape 6).
3. **Cache Metro** : sans `expo start -c` + reload, l'ancien bundle peut persister.

## 4. Axes d'optimisation (priorisés par impact *perçu*)

### 🥇 Tier 1 — Soumission spéculative : recouvrir OCR+LLM par le temps de revue humaine
> ✅ **LIVRÉ** (`CameraScreen.tsx`) — `submitCapture` part **dès la photo prise** (`speculativeRef`),
> en tâche de fond ; Valider **consomme** le résultat (sinon submit frais), Reprendre/refocus
> abandonnent l'ingestion orpheline (append-only, inoffensive). `wait_ms` est désormais mesuré
> **depuis Valider** (le T0 perçu) ; le log capture porte `speculative=true|false`, `cropped`, et
> **`overlap_ms`** = temps déjà passé en traitement **AVANT Valider** (la preuve chiffrée du
> recouvrement : photo traitée dès la prise, pas au tap Valider).

Aujourd'hui la soumission part au tap **Valider**, donc OCR+LLM (2–6 s) sont **séquentiels après**.
Or `CameraScreen` a déjà une étape « Vérifiez la photo » (pause humaine 1–3 s, boutons Reprendre/Valider).
**Lancer `submitCapture` dès la photo PRISE** (état `pending`), en tâche de fond : l'extraction tourne
**pendant** que l'opérateur vérifie la photo. Au tap Valider → Review, l'extraction est déjà finie ou
presque → les champs apparaissent quasi instantanément. Sur Reprendre → ingestion orpheline ignorée
(append-only, inoffensif). **Tout est déjà disponible à la capture** (barcode + crop). **Gain : ~2–6 s
masqués, sans nouvelle dépendance, infra existante.** Coût : une extraction gâchée par reprise (taux
faible en criée). **C'est LE levier #1 pour « je ne sens pas l'attente ».**

### 🥈 Tier 2 — Réveil worker instantané (Postgres LISTEN/NOTIFY)
Le worker poll l'outbox toutes les 1 s → ~0,5 s de pickup moyen (étape 4). Producteur `NOTIFY` à
l'insert outbox, worker `LISTEN` → réveil immédiat. **Gain ~0,5 s.** Effort M.

### 🥉 Tier 3 — Cascade par vagues : déterministe avant le LLM
> 📋 **PLANIFIÉ** — plan d'action détaillé dans `CLAUDE.md` → « Latence perçue — cascade (Tier 1/3/5) ».
> La vraie vague 2 exige un **état worker intermédiaire « OCR fait »** (commit mi-pipeline + statut
> exposé) + des **extracteurs regex** déterministes : backend, chemin chaud append-only, à vérifier
> stack lancée. Vagues 1 (GS1 T+0) et 3 (LLM) déjà en place.

Décomposer l'extraction en **vagues** affichées au fur et à mesure (la « cascade de complétion ») :
- **Vague 1 (T+0)** : GS1 — lot/DLC/poids/GTIN (déjà fait).
- **Vague 2 (~OCR fini, ~1,5–2 s)** : champs **déterministes par regex** sur le texte OCR — dates,
  température, prix, motifs de lot — affichés **avant** que le LLM finisse.
- **Vague 3 (~LLM fini, ~3–5 s)** : champs libres LLM — espèce, nom scientifique, FAO, origine, méthode.
Demande au backend d'exposer un état intermédiaire « OCR fait » + au mobile de rendre par vague.
**Effet : l'écran se remplit en continu → vitesse perçue ≫ réelle.** Effort M. (C'est le « cascade
après 2 s » demandé : du contenu utile dès ~2 s, le LLM complète ensuite.)

### Tier 4 — Long-poll / SSE (latence de détection → 0, et active le streaming)
Remplacer le short-poll par un **long-poll** (le serveur tient la requête jusqu'au changement de
statut, timeout ~25 s) → les champs s'affichent à l'instant où le serveur finit (zéro lag étape 8).
**SSE/WebSocket** en plus permettrait de **streamer les champs LLM un par un** (vrai cascade Tier 3
sans poll). Effort M (long-poll) → L (SSE).

### Tier 5 — Feedback de progression étagé (REMPLACE la « roue »)
> ✅ **LIVRÉ** (`components/ExtractionProgress.tsx` + `services/extractionStage.ts`, pur + testé) —
> **cascade verticale d'états** (Photo envoyée ✓ · Lecture du texte… · Analyse…), point actif qui
> **pulse**. Le `PulseDot` partagé (`components/PulseDot.tsx`) remplace AUSSI l'`ActivityIndicator`
> de `ProcessingOverlay` (upload) → **cohérence totale : zéro roue sur le flux capture→revue**.
> Piloté par le temps écoulé + la phase réelle (estimations ; se branchera sur l'état réel Tier 3).

Remplacer skeletons figés + spinner unique par un indicateur **étagé** : `Envoi ✓ → Lecture du
texte… → Analyse de l'espèce… → Prêt`. Même sans backend (estimations temporisées), ça donne du
mouvement ; avec Tier 3 (états réels), c'est exact. Effort S.

### Tier 6 — OCR on-device (recouvrement total, plus lourd)
ML Kit (`@react-native-ml-kit/text-recognition`) ou frame-processor : OCR **sur l'appareil** pendant
la revue photo → envoyer image **+ texte OCR** → backend saute l'étape 5 (−0,6–2 s). Compromis de
confiance (le gate no-fab s'ancre sur l'OCR) + dépendance native + build. Effort L.

### Tier 7 — Réglages image/OCR (RÉ-ÉVALUÉ : plus marginal vu la mesure §0)
> ✅ **Image réduite LIVRÉ** : crop `≤2000 → ≤1600 px` (`CameraScreen.tsx`), `compress 0.8` → base64
> plus petit = upload **et** OCR Vision plus courts. **Logs ajoutés** : `image_bytes` (worker — taille
> réelle envoyée à Vision) + `framed` (client).
>
> 🐛 **Découvert via les logs : `cropped=false` sur 100 % des scans.** `computeFrameCrop` renvoyait
> `null` (mismatch d'orientation probable) → le resize, **niché dans le bloc crop, ne tournait jamais**
> → image **pleine** envoyée à Vision (les `image_bytes` ~1,4–1,8 Mo étaient des images NON croppées).
> **Corrigé** : crop **obligatoire avant mise en file/OCR**, puis resize du côté long. Aucun
> fallback plein format n'est autorisé ; un échec demande une reprise.
>
> **Diagnostic historique confirmé** : `photo=1920x886` vs `screen=430x932` expliquait l'ancien
> buffer transposé. **Résolu depuis** : `frameCrop.ts` gère les buffers transposés et recadre le rectangle
> exact du cadre. **✅ Résultat du resize inconditionnel : `image_bytes`
> ~1,7 Mo → ~0,4 Mo (4×)**, `ocr_ms` ~2 s, `llm_ms` ~8 s (LLM = dominant). L'application est
> désormais verrouillée en **paysage** et le serveur refuse les images non paysage ;
> `TEXT_DETECTION` / ≤1280px si
> le recall tient.

`≤1600 px` suffit pour l'OCR d'étiquette (base64 plus petit → hop serveur→Vision plus court) ;
`TEXT_DETECTION` (vs `DOCUMENT_TEXT_DETECTION`) plus rapide sur étiquettes courtes (compromis recall).
Effort S, gain faible.

## 5. Design « roue + cascade en vagues » (cible)

```
T+0      [Valider]  ┌ roue « Envoi… »  (upload, 0,3–2 s)
T+~0,5s  Review     ├ Vague 1 : GS1 (lot, DLC, poids, GTIN)         ← instantané
                    │ + bandeau étagé : Envoi ✓ · Lecture… · Analyse…
T+~1,5s             ├ Vague 2 : dates/temp/prix (regex sur OCR)     ← « après ~2 s »
T+~3–5s             └ Vague 3 : espèce, FAO, origine, méthode (LLM) ← complète
```
Combiné à **Tier 1 (spéculatif)**, les vagues 1–2 sont **déjà prêtes** au tap Valider → l'opérateur
voit un écran quasi rempli immédiatement, le LLM ne fait que finir les champs durs.

## 6. Mesurer d'abord — ✅ instrumentation livrée (`4d426a3`), split worker à capturer

État (« on ne dit pas *c'est plus rapide* sans un chiffre ») :
- ✅ **Client** : `logLatency` émet `upload_ms` (capture) + `wait_ms`/`status` (review) en dev →
  **résultats §0** (~6,4 s / ~20,4 s).
- ✅ **Serveur** : `extraction_consumer` logge `extraction_timing { ocr_ms, llm_ms }` par ingestion
  (~0 ms sur dedup, temps réel sur un miss). **🐛 Bug trouvé** : le `JsonFormatter` n'allow-listait
  pas `ocr_ms`/`llm_ms` → l'event se loggait **sans ses chiffres** (le worker était pourtant à jour,
  les events `extraction_timing` bien présents). **Corrigé** : `ocr_ms`/`llm_ms`/`attempts` ajoutés à
  l'allow-list (`observability.py`). **Reste** : `docker compose up -d --build worker` puis rescan +
  `docker compose logs -f worker | grep extraction_timing`. **Mesure n°1** des 14 s post-upload (§0).
- ⬜ **À ajouter (utile vu §0)** : `bytes` + `cropped=true/false` côté client → confirmer/écarter le
  *fallback plein format* (suspect de l'upload 6 s).
- Comparer ≥10 scans par étape une fois le split worker en main → savoir où mettre l'effort.

## 7. Recommandation de séquencement
1. **Instrumentation** (§6) — ✅ client fait ; **capturer le split worker `ocr_ms`/`llm_ms`** (rebuild)
   avant d'optimiser le post-upload, **et corriger l'upload 6 s** (§0) en parallèle — l'anomalie la plus simple.
2. **Tier 1 soumission spéculative** — ✅ LIVRÉ (le plus gros gain perçu, infra existante).
3. **Tier 5 feedback étagé** — ✅ LIVRÉ ; **Tier 3 vagues déterministes** 📋 planifié (backend, voir CLAUDE.md).
4. **Tier 2 LISTEN/NOTIFY** + **Tier 4 long-poll** — rogner les derniers lags.
5. SSE/streaming + OCR on-device = refonte ultérieure si besoin.
