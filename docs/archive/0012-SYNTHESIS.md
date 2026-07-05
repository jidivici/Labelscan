# Synthèse v0012 — UX front (page article + recherche) & extraction FAO ultra-précise

**Date :** 2026-06-20
**Périmètre :** `src/` (app mobile) en majorité + **un** point backend (prompt Haiku, adaptateur OCR→JSON).
**Aucune migration de base de données. Aucun changement de schéma** (`extraction.v1` inchangé).

> Fait suite à [`0011-SYNTHESIS.md`](./0011-SYNTHESIS.md) (chantiers C/D/B/A). Référence front complète :
> [`mobile/MOBILE-APP.md`](./mobile/MOBILE-APP.md). Contrat d'extraction : [`extraction/PROMPT-CONTRACT.md`](./extraction/PROMPT-CONTRACT.md).

---

## 1. En une table

| Sujet | Quoi | Statut | Fichiers |
|---|---|---|---|
| **Page centrale (Articles)** | Liste à plat **triée par nom de produit (A→Z)** ; **pas de compteur** ; carte = **« nom de produit - lot »** puis **date d'enregistrement DD/MM/YYYY** dessous | Livré + vérifié | [`ArticleListScreen`](../src/screens/ArticleListScreen.tsx), [`ArticleCard`](../src/components/ArticleCard.tsx), [`articleGrouping.ts`](../src/services/articleGrouping.ts) |
| **Fiche produit (immuable)** | Bug « beaucoup de caractères » corrigé (échappements `\uXXXX` en JSX) ; dates en **DD/MM/YYYY** ; libellés FR | Livré + vérifié | [`ArticleDetailScreen`](../src/screens/ArticleDetailScreen.tsx) |
| **Omni-recherche** | Tous les champs + code-barres ; accents/casse-insensible ; multi-termes ET | Livré + vérifié | [`useArticleSearch`](../src/hooks/useArticleSearch.ts), [`articleSearch.ts`](../src/services/articleSearch.ts) |
| **Français métier** | Libellés de champ + statuts + `production_method` (Élevage / Pêche sauvage) | Livré | [`fieldLabels.ts`](../src/services/fieldLabels.ts) |
| **Dates** | `formatDate` (long, en-tête revue) + `formatDateShort` (**DD/MM/YYYY**, articles) ; plus de « Invalid date » | Livré + vérifié | [`dates.ts`](../src/services/dates.ts) |
| **Photo** | Persistée par **copie** (`.jpg` fixe) — corrige la perte de photo | Livré | [`storage.ts`](../src/services/storage.ts) |
| **FAO — extraction (backend)** | Prompt Haiku **v1.2.0** : capture la désignation FAO **complète, verbatim, avec la sous-zone** + RÈGLE 7 (français si multilingue) | Code livré ; **grille d'éval + (re)déploiement requis** | [`claude_llm_provider.py`](../server/src/labelscan/contexts/ingestion/adapters/claude_llm_provider.py), PROMPT-CONTRACT §8 |

`npm run typecheck` ✅ · `npx jest` ✅ **80/80** · backend `run_local_proofs.sh` ✅ **192 passed, 1 skipped**.

---

## 2. La sous-zone FAO « captée mais pas affichée » — où elle se perd (et où **non**)

Constat utilisateur : *« l'OCR capte la sous-zone mais le résultat ne l'affiche pas. »* Trace complète :

- **OCR** (Google Vision, serveur) — lit le texte brut, sous-zone incluse. ✅
- **Pipeline** (`evaluate` → `reconcile` → persistance → `registration_consumer`) — transmet `FAO_area`
  **sans le tronquer** ; GS1 ne réclame **pas** FAO (`gs1_resolved_field_names` = lot/DLC/poids/GTIN/embmballage) ;
  `reconcile()` laisse FAO intact ; la traçabilité stocke `vals.get("FAO_area")` **tel quel**. ✅ (rien à corriger)
- **Affichage mobile** — la valeur FAO est montrée **entière** (en-tête + liste de la fiche, aucun
  `numberOfLines`). ✅ (rien à corriger)
- **Extraction LLM** — **c'est le seul point décisif.** L'ancien prompt traitait « Atlantique Nord-Est,
  sous-zone VIII » comme un **nom de lieu** → `FAO_area` null/ambigu → perdu. **v1.2.0** capture la
  désignation **verbatim, sous-zone comprise** (numérique `27.8.b.1` *ou* en toutes lettres/romain), sans
  jamais convertir un nom de lieu en numéro.

**Conclusion :** la sous-zone n'apparaîtra dans le résultat qu'après **(1) (re)déploiement du backend en
v1.2.0** (l'image serveur en service doit être reconstruite — `docker compose … up -d --build server worker`)
**et (2) un nouveau scan**. Les articles déjà enregistrés sont **immuables** (ADR-0003) : ils gardent leur
ancienne valeur FAO. *(La suggestion de code FAO côté mobile a été retirée — choix produit ;
la fiche affiche la désignation FAO captée, sous-zone comprise.)*

> **Discipline prompt caché** (inchangée) : éditer le préfixe Haiku = **bump MINOR** (v1.1.0 → **v1.2.0**)
> + **grille d'éval SC1/SC3/SC8/SC10** avant prod (non exécutable hors clé/réseau/coût), et invalide le
> cache une fois (réécriture ~1,25× puis ~0,1×). Voir PROMPT-CONTRACT §8.

---

## 3. Le piège JSX (cause du « beaucoup de caractères mal formatés »)

Sur la fiche immuable, des libellés étaient écrits avec des échappements `\uXXXX` **dans du texte/des
attributs JSX** (`>Détail du lot<`, `label="Numéro de lot"`). **JSX n'interprète pas** les
échappements JS hors `{…}` → ils s'affichaient **littéralement** (`Détail…`). Corrigé en écrivant les
caractères **en clair** (é, ê, '). Règle : dans le JSX, toujours des caractères accentués littéraux, jamais
`\uXXXX` (qui ne marche que dans une string JS, p. ex. `Alert.alert('…’…')`).

---

## 4. Écarts / à suivre

- **Re-déploiement backend v1.2.0** requis pour voir la sous-zone (ci-dessus).
- **Grille d'éval FAO** (cas FR : « ATLANTIQUE NORD-EST, SOUS-ZONE VIII ET AUTRES SOUS-ZONES » ; label
  bilingue EN/FR) à passer avant rollout prod.
- **Poids/prix/température en clavier numérique** : nécessiterait de séparer valeur + unité (évolution).
- **Renvoi des corrections mobiles vers le backend** : devra reconvertir DD/MM/YYYY → ISO (le gate
  chronologique repose sur l'ordre lexical ISO).
