# Synthèse v0011 — Refonte capture (C) + couverture OCR (D) + suggestions allergènes (B) + audit latence (A)

**Date :** 2026-06-20
**Périmètre :** `src/` (app mobile Expo) en majorité + **un** point `server/` (adaptateur OCR Google Vision).
**Aucune migration de base de données.** Aucun nouveau drapeau (la sélection du chemin reste
`EXPO_PUBLIC_BACKEND_FIRST`, défaut = backend).

> **Honnêteté d'abord.** Trois chantiers (B, C, D) sont **livrés et vérifiés** ; le chantier A (latence)
> est un **audit** : les seuls vrais leviers LLM touchent le **prompt caché** (→ bump MINOR + grille
> d'éval SC1/SC3/SC10) et sont donc **proposés, pas appliqués**. La discipline « on ne modifie pas le
> préfixe caché à l'aveugle » de [`0010-SYNTHESIS.md`](./0010-SYNTHESIS.md) est respectée.

---

## Les 4 chantiers en une table

| Chantier | Quoi | Statut | Fichiers principaux |
|---|---|---|---|
| **C — Flux** | Pile unique (Articles = accueil, plus d'onglet) ; FAB de capture bas-droite ; boucle de capture continue | **Livré + vérifié** | [`RootNavigator.tsx`](../src/navigation/RootNavigator.tsx), [`CaptureFab.tsx`](../src/components/CaptureFab.tsx), [`CameraScreen.tsx`](../src/screens/CameraScreen.tsx), [`ArticleListScreen.tsx`](../src/screens/ArticleListScreen.tsx) |
| **D — Couverture OCR** | Cadre ≈ toute la zone utile + marge de sécurité au recadrage ; capture pleine fidélité ; backend `DOCUMENT_TEXT_DETECTION` + `languageHints` fr/en | **Livré + vérifié** | [`CameraScreen.tsx`](../src/screens/CameraScreen.tsx), [`FrameOverlay.tsx`](../src/components/FrameOverlay.tsx), [`google_vision_ocr.py`](../server/src/labelscan/contexts/ingestion/adapters/google_vision_ocr.py) |
| **B — Suggestions allergènes** | Suggestion espèce→famille (Annexe II UE), confirmée par l'humain (`source='human'`), jamais auto-stockée | **Livré + vérifié** (finalisé dans cette synthèse) | [`allergenSuggestions.ts`](../src/services/allergenSuggestions.ts), [`ReviewScreen.tsx`](../src/screens/ReviewScreen.tsx), [`allergenSuggestions.test.ts`](../src/__tests__/allergenSuggestions.test.ts) |
| **A — Latence** | Audit ; correctifs sûrs uniquement ; gains LLM **proposés** (prompt caché ⇒ MINOR) | **Audit / proposé** | — (voir [`ai-pipeline/AI-PIPELINE.md`](./ai-pipeline/AI-PIPELINE.md) §1.5–1.6, [`0010-SYNTHESIS.md`](./0010-SYNTHESIS.md)) |

Détail mobile complet dans le nouveau doc de référence [`mobile/MOBILE-APP.md`](./mobile/MOBILE-APP.md).

---

## C — Refonte du flux de capture

**Avant :** la capture était un onglet de barre inférieure (toujours montée → la caméra tenait la
ressource en permanence). **Après :** une **pile unique** (`RootStackParamList`) avec **Articles comme
écran d'accueil** ; Camera + Review sont **poussés à la demande** depuis un **FAB** (bouton flottant)
en bas-droite de la liste d'articles.

- **Boucle de capture continue :** `ArticleList → (FAB) → Camera → (photo) → revue locale →
  (Valider) → Review → (Enregistrer) → retour à la caméra encore ouverte` pour l'étiquette suivante.
  « Reprendre » rouvre la caméra. Le retour aux Articles se fait par la flèche en haut-gauche de la
  caméra (qui dépile tout le module de capture).
- **Ressource caméra libérée :** la `CameraView` n'est montée **que** lorsque l'écran Camera a le
  focus (`useIsFocused`) — donc relâchée dès que Review (modal) passe au-dessus, et libérée pour de
  bon au retour Articles. `expo-camera` n'autorise qu'un seul aperçu actif à la fois ; c'est la raison
  d'être de ce montage conditionnel.
- **FAB :** cercle primaire, icône `camera-plus`, badge (compte d'articles, sinon point discret).

---

## D — Couverture OCR (le correctif « il manque des infos de l'étiquette »)

**Cause racine identifiée :** un recadrage trop serré. Le cadre était un petit rectangle ; tout ce qui
**débordait** était coupé **avant** l'OCR → des champs présents sur l'étiquette disparaissaient. Tension
directe avec la consigne « la photo doit correspondre uniquement au cadre » : cadre serré = propre mais
perd les bords.

**Correctifs (par impact) :**

1. **Couverture du cadre** — le cadre fait désormais **≈96 % de la largeur** et occupe la quasi-totalité
   de la zone utile (entre la barre du haut et le bandeau du bas), pour que l'opérateur place
   **l'étiquette entière** dedans. (`CameraScreen.tsx` : `FRAME_LEFT = SCREEN_WIDTH * 0.02`, `FRAME_*`.)
2. **Marge de sécurité au recadrage** — `computeFrameCrop` **élargit** le rectangle de **8 %** sur
   chaque axe avant d'inverser la transformation « cover », puis **borne** dans les pixels de la photo.
   Une étiquette collée aux coins n'est plus rognée ; on ne lit jamais hors limites.
3. **Fidélité image** — capture `quality: 1.0` et recadrage `compress: 1.0` (**pas de
   recompression/sous-échantillonnage** côté client) → le petit texte passe mieux.
4. **Garde d'orientation** — `takePictureAsync({ skipProcessing: false })` applique la rotation capteur
   ; si le buffer revient transposé ou si le rectangle est dégénéré, `computeFrameCrop` renvoie `null`
   et l'**image entière** est envoyée (jamais de perte de données).
5. **Backend Vision** — l'adaptateur serveur utilise `DOCUMENT_TEXT_DETECTION` + `imageContext.languageHints = ["fr","en"]`
   (aide au rappel sur le FR+EN accentué), et **n'effectue aucun sous-échantillonnage** (l'image part en
   pleine résolution). Voir [`AI-PIPELINE.md`](./ai-pipeline/AI-PIPELINE.md) §2.5.

> **Note legacy :** `src/services/ocr.ts` (chemin **opt-out** `EXPO_PUBLIC_BACKEND_FIRST=false`) utilise
> encore `TEXT_DETECTION` sans `languageHints`. C'est volontairement le chemin secondaire ; le défaut est
> le backend. À aligner si l'on conserve durablement le legacy (voir « Écarts » plus bas).

---

## B — Suggestions d'allergènes (aide à la décision, **pas** de l'extraction)

**Cadre conforme (option 2, le choix le plus sûr) :** une **suggestion** d'une famille d'allergènes de
l'**Annexe II UE** — `Poisson` / `Crustacés` / `Mollusques` — dérivée **déterministiquement** du nom
d'espèce/produit (`scientific_name`, `product_name`, `commercial_designation`).

- **Jamais une fabrication.** Le pipeline d'extraction ne change pas : une valeur non imprimée reste
  `null` et part en revue (gate anti-fabrication — [`PROMPT-CONTRACT.md`](./extraction/PROMPT-CONTRACT.md)).
  La suggestion est une **couche mobile** séparée.
- **Affichée, jamais auto-appliquée.** Le chip n'apparaît **que** sur le champ `allergens` et **que**
  s'il est vide. L'accepter écrit une **valeur humaine** (`edited` → `source='human'` à
  l'enregistrement), jamais une valeur « extraite ». Les allergènes déclarés sur l'étiquette priment.
- **Jamais de devinette.** Mélange ambigu (« fruits de mer », « assortiment »…) ou espèce inconnue ⇒
  `null` (pas de chip). **Provenance/FAO ne sont PAS déduits** (port→FAO est non déterministe et
  réglementé — interdit par le PROMPT-CONTRACT) : ils restent saisis à la main.

**Ce qui a été finalisé dans cette passe** (le module existait mais n'était **pas câblé**) :

1. **Câblage** — `ReviewScreen` calcule `suggestAllergen(fields)` (`useMemo`) et passe la suggestion
   **au seul** champ `allergens`. (Avant : la fonction était importée mais jamais appelée → fonctionnalité
   morte.)
2. **Styles manquants** — `suggestionChip` / `suggestionChipText` (absents → cassaient le typecheck).
3. **Durcissement** — `normalize()` ne dépend plus d'une regex à **caractères combinants invisibles**
   dans le source ; elle filtre par **point de code** (U+0300–U+036F), robuste au copier-coller/éditeur.
4. **Test unitaire** — `allergenSuggestions.test.ts` (13 cas : familles, précédence crustacé>poisson,
   anti-accent, « fruits de mer » → null, frontières de mots, champs lus).

---

## A — Latence (audit ; rien de risqué appliqué)

- L'extraction est **asynchrone** (hors chemin requête, BACKEND §1.1) : le « ×2 » se gagne surtout en
  **perçu** (afficher GS1 + suggestions tout de suite) et en réglages **sûrs**.
- **Aucune modification du prompt caché.** `max_tokens 4096` est un **plafond**, pas une cible ;
  `thinking`/`effort` sont correctement absents sur Haiku ; OCR→LLM est une **dépendance de données**
  réelle (rien à paralléliser dans une étiquette). Les vrais gains (borner les `evidence` en sortie,
  alléger les few-shots) **changent le préfixe caché** ⇒ **bump MINOR + grille d'éval** ⇒ **proposés,
  pas appliqués**. Voir [`0010-SYNTHESIS.md`](./0010-SYNTHESIS.md) (cache + escalade) et
  [`AI-PIPELINE.md`](./ai-pipeline/AI-PIPELINE.md) §1.5–1.6.

---

## Vérification

| Cible | Commande | Résultat |
|---|---|---|
| **Mobile — types** | `npm run typecheck` | **propre** (0 erreur) |
| **Mobile — tests** | `npx jest --config jest.config.js` | **34 passés / 4 suites** (dont 13 nouveaux tests allergènes ; 21 → 34) |
| **Backend — OCR config** | `test_ocr_config.py` | ajouté lors du chantier D (langue + pleine résolution) |
| **Backend — preuves** | `bash server/scripts/run_local_proofs.sh` (PG éphémère) | **192 passés / 1 skip** lors du run de l'agent backend — **à rejouer** pour un état frais de cette synthèse |

> Le backend n'a **pas** été rejoué dans cette passe (le correctif OCR backend était déjà livré +
> vérifié par l'agent). `run_local_proofs.sh` exige un PostgreSQL éphémère ; voir
> [`labelscan-test-suite`](../server/README.md).

---

## Écarts & suites possibles (honnêteté)

- **Expo SDK 54 vs v56 :** `package.json` épingle `expo ~54.0.35`, mais [`AGENTS.md`](../AGENTS.md)
  renvoie aux docs **v56**. À réconcilier (migration prévue, ou corriger le pointeur de doc).
- **Legacy OCR :** `src/services/ocr.ts` (`TEXT_DETECTION`, sans `languageHints`) n'a pas été aligné sur
  le backend — c'est le chemin **opt-out**, pas le défaut.
- **Wordlist allergènes :** curée et **non exhaustive** (certains pluriels manquent ⇒ pas de suggestion,
  jamais de mauvaise suggestion). C'est **sûr par construction** (l'humain confirme) ; le **rappel** est
  améliorable plus tard.

---

## Liens

- [`mobile/MOBILE-APP.md`](./mobile/MOBILE-APP.md) — référence de l'app mobile (flux, OCR, allergènes).
- [`ai-pipeline/AI-PIPELINE.md`](./ai-pipeline/AI-PIPELINE.md) §2.5 — config concrète de l'adaptateur Vision.
- [`extraction/PROMPT-CONTRACT.md`](./extraction/PROMPT-CONTRACT.md) — gate anti-fabrication (inchangé).
- [`0010-SYNTHESIS.md`](./0010-SYNTHESIS.md) — cache de prompt + escalade (contexte latence/coût).
- [`../WORKTREES-GUIDE-DEBUTANT.md`](../WORKTREES-GUIDE-DEBUTANT.md) — guide worktrees pour débutant.
