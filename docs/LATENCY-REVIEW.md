# Revue de latence + livraison — session 21 juin 2026

> ⚠️ Les durées par étape sont des **estimations** (ordres de grandeur Vision/Haiku + constantes
> du code). Aucune mesure on-device n'a été faite — voir §6 « Mesurer d'abord ».

## 1. Features livrées cette session (audit)

| Commit | Périmètre | Vérifié |
|--------|-----------|---------|
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

**Total ≈ 3–9 s.** Le **cœur incompressible = étapes 5+6 (OCR+LLM) ≈ 2–6 s**, strictement séquentielles
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

### Tier 5 — Feedback de progression étagé (la « roue »)
Remplacer skeletons figés + spinner unique par un indicateur **étagé** : `Envoi ✓ → Lecture du
texte… → Analyse de l'espèce… → Prêt`. Même sans backend (estimations temporisées), ça donne du
mouvement ; avec Tier 3 (états réels), c'est exact. Effort S.

### Tier 6 — OCR on-device (recouvrement total, plus lourd)
ML Kit (`@react-native-ml-kit/text-recognition`) ou frame-processor : OCR **sur l'appareil** pendant
la revue photo → envoyer image **+ texte OCR** → backend saute l'étape 5 (−0,6–2 s). Compromis de
confiance (le gate no-fab s'ancre sur l'OCR) + dépendance native + build. Effort L.

### Tier 7 — Réglages image/OCR (marginal)
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

## 6. Mesurer d'abord (prérequis)

Tu ne peux pas dire « c'est plus rapide » faute de **mesure**. Avant d'optimiser :
- **Client** : logguer `capture → upload_done` et `upload_done → fields_ready` (timestamps dans
  `confirmAndSubmit` / `useIngestionResult`), affichés dans un HUD dev.
- **Serveur** : les logs portent déjà des timestamps (`extraction_persisted`) ; ajouter la durée
  OCR et LLM séparément (`ocr_ms`, `llm_ms`) dans `extraction_consumer` pour isoler le dominant.
- Comparer 10 scans avant/après par étape → savoir où mettre l'effort (probablement étape 6 LLM).

## 7. Recommandation de séquencement
1. **Instrumentation** (§6) — savoir où va le temps.
2. **Tier 1 soumission spéculative** — le plus gros gain perçu, infra existante.
3. **Tier 3 vagues déterministes** + **Tier 5 feedback étagé** — la « cascade » demandée.
4. **Tier 2 LISTEN/NOTIFY** + **Tier 4 long-poll** — rogner les derniers lags.
5. SSE/streaming + OCR on-device = refonte ultérieure si besoin.
