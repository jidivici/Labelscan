# LabelScan — Application mobile (Expo / React Native)

**Statut :** Implémenté. Client mince Expo (SDK 54) ; l'extraction « lourde » (OCR + LLM) vit côté
serveur. Ce document est la **référence du front mobile** — les docs `docs/` étant historiquement
côté backend, celui-ci comble le manque.
**Date :** 2026-06-20
**Périmètre :** `src/` uniquement.

> **À lire en regard :**
> - [`../backend/API-CONTRACTS.md`](../backend/API-CONTRACTS.md) — les endpoints que le client appelle.
> - [`../ai-pipeline/AI-PIPELINE.md`](../ai-pipeline/AI-PIPELINE.md) — OCR + extraction côté serveur.
> - [`../extraction/PROMPT-CONTRACT.md`](../extraction/PROMPT-CONTRACT.md) — le gate anti-fabrication.
> - [`../0011-SYNTHESIS.md`](../0011-SYNTHESIS.md) — synthèse des chantiers C/D/B/A.
> - [`../0012-SYNTHESIS.md`](../0012-SYNTHESIS.md) — synthèse UX article + recherche + FAO v1.2.0.

---

## 1. Vue d'ensemble

- **Auth** : JWT par appareil (`POST /v1/auth/login`), token attaché en `Authorization: Bearer`
  ([`services/auth.ts`](../../src/services/auth.ts), [`services/api.ts`](../../src/services/api.ts)).
  Toute l'app est derrière l'écran de connexion ([`context/AuthContext.tsx`](../../src/context/AuthContext.tsx)).
- **Deux chemins d'extraction**, sélectionnés par `EXPO_PUBLIC_BACKEND_FIRST` (défaut = **backend**) :
  - **backend** (défaut) : recadrage au cadre → `POST /v1/ingestions` → polling du statut → récupération
    du run d'extraction → écran de vérification éditable → enregistrement local de l'article.
  - **legacy** (`=false`) : OCR sur l'appareil via Google Vision ([`services/ocr.ts`](../../src/services/ocr.ts)),
    affichage seul (pas d'enregistrement — il n'y a pas de modèle d'article on-device).
- **Stockage local** : articles sauvegardés + file d'attente (outbox) en AsyncStorage
  ([`services/storage.ts`](../../src/services/storage.ts), [`services/outbox.ts`](../../src/services/outbox.ts)).

---

## 2. Navigation & flux de capture (chantier C)

**Une pile racine unique** ([`navigation/RootNavigator.tsx`](../../src/navigation/RootNavigator.tsx)) :
`ArticleList` (accueil) · `ArticleDetail` · `Camera` · `Review` (présenté en modal). **Plus d'onglet** de
capture — la capture se lance à la demande via un **FAB** (bouton flottant) en bas-droite de la liste
([`components/CaptureFab.tsx`](../../src/components/CaptureFab.tsx)).

**Boucle de capture continue** (saisie rapide à la chaîne) :

```
ArticleList ──(FAB)──▶ Camera ──(photo)──▶ revue locale ──(Valider)──▶ Review
     ▲                   ▲                                                 │
     │                   └──────────────(Enregistrer / Reprendre)─────────┘
     └────────────(flèche « retour » de la caméra ⇒ dépile le module)
```

- Après **Enregistrer**, Review **dépile** vers la caméra **toujours montée** (prête pour l'étiquette
  suivante), pas jusqu'aux Articles. On revient aux Articles par la **flèche en haut-gauche** de la
  caméra.
- **Ressource caméra** : `CameraView` n'est montée que lorsque l'écran Camera est **focalisé**
  (`useIsFocused`), donc relâchée dès que Review passe au-dessus et libérée au retour Articles —
  `expo-camera` n'autorise qu'**un** aperçu actif à la fois.

---

## 3. Capture & couverture OCR (chantier D)

Le **cadre à l'écran est à la fois le guide de placement ET la région de recadrage**
([`screens/CameraScreen.tsx`](../../src/screens/CameraScreen.tsx), [`components/FrameOverlay.tsx`](../../src/components/FrameOverlay.tsx)).

- **Couverture** : le cadre fait **≈96 % de la largeur** et occupe la quasi-totalité de la zone utile,
  pour placer **l'étiquette entière** dedans (le correctif du « il manque des infos » — un cadre trop
  serré coupait les bords avant l'OCR).
- **Marge de sécurité** : `computeFrameCrop` élargit le rectangle de **8 % par axe** avant d'inverser la
  transformation d'affichage « cover », puis **borne** dans les pixels de la photo (jamais hors limites).
- **Fidélité** : `takePictureAsync({ quality: 1.0 })` + recadrage `compress: 1.0` (pas de recompression
  côté client).
- **Robustesse** : `skipProcessing: false` applique la rotation capteur ; si l'image revient transposée
  ou le rectangle est dégénéré, on **envoie l'image entière** (fallback sans perte).
- **Côté serveur** : `DOCUMENT_TEXT_DETECTION` + `languageHints ["fr","en"]`, sans sous-échantillonnage
  (voir [`AI-PIPELINE.md`](../ai-pipeline/AI-PIPELINE.md) §2.5).

---

## 4. Suggestions d'allergènes (chantier B) — aide à la décision, **pas** de l'extraction

[`services/allergenSuggestions.ts`](../../src/services/allergenSuggestions.ts) +
[`screens/ReviewScreen.tsx`](../../src/screens/ReviewScreen.tsx).

`suggestAllergen(fields)` dérive **déterministiquement** une famille de l'**Annexe II UE**
(`Poisson` / `Crustacés` / `Mollusques`) à partir de `scientific_name` / `product_name` /
`commercial_designation`. Règles de conformité :

- **Suggestion, jamais auto-application.** Le chip n'apparaît que sur le champ `allergens` et que s'il
  est **vide**. L'accepter écrit une **valeur humaine** (`source='human'` à l'enregistrement), jamais
  une valeur « extraite ». Les allergènes **déclarés sur l'étiquette priment**.
- **Jamais de devinette.** Mélange ambigu (« fruits de mer ») ou espèce inconnue ⇒ `null` (pas de chip).
- **Pas de provenance/FAO déduits** : interdit par le PROMPT-CONTRACT (port→FAO non déterministe et
  réglementé). Le gate anti-fabrication de l'extraction est **inchangé**.
- **Wordlist** curée et non exhaustive : un manque ⇒ pas de suggestion (sûr), jamais une mauvaise.

Couvert par [`__tests__/allergenSuggestions.test.ts`](../../src/__tests__/allergenSuggestions.test.ts).

### Aide à la saisie des dates (`expiry_date` / `packaging_date`)

Clavier numérique (`number-pad`) + masque **DD/MM/YYYY** (insertion auto du `/`) —
[`services/inputMasks.ts`](../../src/services/inputMasks.ts), couvert par
[`__tests__/inputMasks.test.ts`](../../src/__tests__/inputMasks.test.ts). C'est une
**aide à la saisie**, pas une valeur calculée : **pas** d'« expiry = packaging + N
jours » (la durée de vie n'est pas constante → ce serait une fabrication d'une date
critique pour le HACCP). Les champs portant une **unité** (poids/prix/température)
gardent le clavier complet pour que l'unité (g/kg/EUR/°C) reste saisissable — les
passer en clavier numérique imposerait de séparer valeur et unité (évolution possible).

**Format DD/MM/YYYY de bout en bout (mobile).** Les dates extraites (ISO `YYYY-MM-DD`
côté backend) sont **affichées et enregistrées en DD/MM/YYYY** (`displayDate`) ; le **run
brut** (`raw_extraction_run`) conserve l'**ISO** d'origine (provenance). ⚠ L'**ISO reste
le format canonique backend** : la vérif chronologique `expiry < packaging` (gate
d'extraction, `domain/extraction.py`) repose sur l'ordre lexical = ISO, que DD/MM/YYYY
casse au passage d'année. Un renvoi éventuel des corrections vers le backend devra donc
reconvertir DD/MM/YYYY → ISO à cette frontière.

### Libellés FR + saisie par unité (formulaire de revue)

- **Libellés métier** : les clés d'extraction (anglais) sont rendues en français —
  [`services/fieldLabels.ts`](../../src/services/fieldLabels.ts) (`batch_number` →
  « N° de lot », `FAO_area` → « Zone de pêche (FAO) »…) ; les `validation_status` aussi.
- **Poids** : champ numérique + affixe d'unité **kg ⇄ g** (tap). Aucune conversion
  automatique g→kg (jamais d'erreur ×1000) ; enregistre « 5 kg ».
- **Température de conservation** : deux champs **[min] – [max] °C**. Parse l'existant
  (« 0-4 C », « <=4 C », « -18 C »…) et ne **reconstruit qu'à l'édition** (le run brut
  garde l'original). `parseWeight`/`parseTemp` couverts par `inputMasks.test.ts`.
- **Dates** : `formatDate` (français long « 20 juin 2026 ») pour l'en-tête de revue ;
  `formatDateShort` (**DD/MM/YYYY**) pour les pages **article** (liste + fiche produit).
  Repli sur aujourd'hui si la valeur est absente/invalide (plus de « Invalid date »),
  jamais de date codée en dur — [`services/dates.ts`](../../src/services/dates.ts).
- **Validation** : bouton « Enregistrer l'arrivage » + **haptique de succès** léger.

### Dates unifiées, statuts FR, recherche par lot

- **Dates unifiées** : [`services/dates.ts`](../../src/services/dates.ts) — `formatDate`
  (« 20 juin 2026 », en-tête de revue) et `formatDateShort` (**« 20/06/2026 »**, cartes +
  fiche produit). Repli sur aujourd'hui si invalide → plus jamais de « Invalid date ».
- **Statuts/champs en français** : `ingestionStatusFr` (`extracted` → « Extrait »,
  `needs_review` → « À vérifier »…) et `fieldLabelFr` (clés d'extraction anglaises →
  libellés métier) — aucun code technique affiché.
- **Omni-recherche** (liste Articles) : une barre filtre sur **tous les champs** (lot,
  espèce, zone FAO, méthode d'élevage, fournisseur…) + code-barres, insensible aux
  accents/casse, multi-termes en ET — hook [`hooks/useArticleSearch.ts`](../../src/hooks/useArticleSearch.ts)
  sur logique pure [`services/articleSearch.ts`](../../src/services/articleSearch.ts)
  (testée). « élevage » / « sauvage » trouvent `farmed` / `wild_caught` (valeur francisée).
- **Fiche produit allégée** : plus de tag « modifié », plus de bandeau verbeux ; la
  zone FAO précise est mise en avant en en-tête quand dispo ; `production_method` affichée
  en français (Élevage / Pêche sauvage). **Plus de % de confiance** — un seul tag
  « À vérifier » quand la valeur affichée est incertaine (< 70 % ou statut ambigu,
  [`services/fieldStatus.ts`](../../src/services/fieldStatus.ts)). Écran **chargé en lazy**
  (`React.lazy`, [`RootNavigator`](../../src/navigation/RootNavigator.tsx)).
- **Photo** : persistée par **copie** (`.jpg` fixe) — corrige la perte de photo liée à
  l'URI de cache du recadrage ([`services/storage.ts`](../../src/services/storage.ts)).
- **Accueil (page centrale)** : liste à plat **triée par nom de produit (A→Z)** —
  `sortArticlesByName` ([`services/articleGrouping.ts`](../../src/services/articleGrouping.ts),
  testé). **Pas de compteur.** Chaque carte affiche **« nom de produit - lot »** puis la
  **date d'enregistrement en DD/MM/YYYY** en dessous (`formatDateShort`).
- **Zone FAO (avec sous-zone)** : la désignation imprimée (« Atlantique Nord-Est,
  sous-zone VIII… » ou un code `27.8.b.1`) est **captée verbatim par l'extraction backend
  (prompt v1.2.0)**, puis **mise en forme à l'affichage** par `formatFaoDisplay`
  ([`services/faoDisplay.ts`](../../src/services/faoDisplay.ts)) → « **27 Atlantique Nord-Est
  - Sous zone: (V)** » (n° + nom officiel + sous-zone en romain ; valeur brute conservée,
  affichée sans `numberOfLines`). **Pas de chip de suggestion FAO** (retiré — choix produit).
  - **D'où vient la sous-zone ?** De l'**extraction LLM** uniquement. Le pipeline backend
    (gate → `reconcile` → persistance → traçabilité) transmet `FAO_area` **sans le tronquer**
    (GS1 ne réclame pas FAO). La capture dépend donc du **prompt v1.2.0** (PROMPT-CONTRACT §8) :
    **(re)déployer le serveur** puis **re-scanner** ; les lots déjà enregistrés sont
    **immuables** (ancienne valeur FAO conservée).

---

## 5. Configuration (variables d'environnement Expo)

| Variable | Rôle | Défaut |
|---|---|---|
| `EXPO_PUBLIC_API_BASE_URL` | Base URL du backend | vide → l'API lève une erreur claire |
| `EXPO_PUBLIC_BACKEND_FIRST` | Chemin de capture | non défini/`true` → backend ; `false`/`0` → legacy |
| `EXPO_PUBLIC_GOOGLE_VISION_KEY` | Clé Vision **(legacy on-device uniquement)** | requise seulement si `BACKEND_FIRST=false` |

> ⚠ En mode legacy, la clé Vision est **embarquée dans le bundle JS** (visible en logs réseau) —
> acceptable pour une démo, à restreindre au package de l'app. Le mode **backend** (défaut) n'embarque
> aucune clé : l'OCR tourne côté serveur (cf. `AI-PIPELINE.md` §2.3).

---

## 6. Carte du code (`src/`)

- **`navigation/`** — `RootNavigator` (pile unique, types de paramètres `RootStackParamList`).
- **`screens/`** — `ArticleList` (accueil + FAB + export), `ArticleDetail`, `Camera` (viseur + capture +
  recadrage), `Review` (vérification éditable, deux modes : backend / legacy), `Login`.
- **`components/`** — `CaptureFab`, `FrameOverlay`, `CaptureButton`, `ProcessingOverlay`, `FlashOverlay`,
  `ArticleCard`, `EmptyState`.
- **`services/`** — I/O : `api`, `auth`/`authStorage`, `ingestionSubmit`, `ingestionPolling`,
  `ocr` (legacy), `storage`, `outbox`, `export`. Helpers **purs** (testables) : `dates`
  (formatage FR), `inputMasks` (masque date + poids/température), `fieldLabels` (libellés +
  valeurs FR), `allergenSuggestions`, `articleSearch` (omni-recherche), `articleGrouping`
  (tri par nom de produit).
- **`hooks/`** — `useArticleSearch` (état de l'omni-recherche).
- **`types/`** — `api.ts` (miroir des contrats backend, sous-ensemble fidèle), `Article.ts`.
- **`theme/`** — tokens Material You (couleurs, espacements, typographie, élévation).

---

## 7. Tests

`npx jest --config jest.config.js` (ts-jest, environnement node) — suites : `api`,
`ingestionPolling`, `outbox`, `allergenSuggestions`, `inputMasks`, `dates`, `articleSearch`,
`articleGrouping`, `faoDisplay`, `fieldStatus` (**80 tests**). Vérification de types : `npm run typecheck`.

> **Piège JSX (corrigé) :** un libellé écrit `"Numéro de lot"` dans un **texte ou
> attribut JSX** s'affiche **littéralement** (`Numéro…`) — JSX n'interprète pas les
> échappements JS hors `{…}`. Toujours écrire les caractères accentués **en clair** (é, ê,
> à) dans le JSX. C'était la cause du « beaucoup de caractères mal formatés » sur la fiche.

---

## 8. Liens

- [`../0011-SYNTHESIS.md`](../0011-SYNTHESIS.md) — synthèse C/D/B/A · [`../0012-SYNTHESIS.md`](../0012-SYNTHESIS.md) — synthèse UX article + recherche + FAO v1.2.0.
- [`../backend/API-CONTRACTS.md`](../backend/API-CONTRACTS.md), [`../ai-pipeline/AI-PIPELINE.md`](../ai-pipeline/AI-PIPELINE.md).
- [`../../WORKTREES-GUIDE-DEBUTANT.md`](../../WORKTREES-GUIDE-DEBUTANT.md) — guide worktrees pour débutant.
