# Synthèse v0010 — Cache de prompt (Work Item B) + escalade deux niveaux (Work Item A)

**Date :** 2026-06-19
**Périmètre :** `server/` (contexte `ingestion`). Migration `0010` (additive, colonnes nullables).
**Drapeaux :** escalade **OFF par défaut** (`LABELSCAN_LLM_ESCALATION_ENABLED=false`), cache **ON par
défaut** (`LABELSCAN_LLM_PROMPT_CACHE_ENABLED=true`). La feature escalade est livrée « dark ».

> **Honnêteté d'abord.** Les chiffres de coût/latence ci-dessous sont **illustratifs** et marqués
> *[à mesurer]* — ils donnent la *forme* du gain, pas une facture. Les mesures réelles se font avec
> `count_tokens` + la télémétrie de prod (voir §4). C'est la même discipline que
> [`ai-pipeline/model-and-cost-notes.md`](./ai-pipeline/model-and-cost-notes.md).

---

## Ancienne version vs nouvelle (en une table)

| Aspect | Ancienne (avant v0010) | Nouvelle (v0010) |
|---|---|---|
| Extracteur LLM | Haiku 4.5 seul | Haiku 4.5 primaire **+** Opus 4.8 en escalade (cas durs uniquement) |
| Prompt système | court (< 4096 tokens) | **statique ≥ 4096 tokens** (règles anti-fabrication + schéma + 3 few-shot) |
| Cache de prompt | inopérant (préfixe trop court → Haiku ne cache qu'à ≥ 4096) | **actif** : 1 breakpoint `cache_control` en fin de préfixe statique |
| Cas dur non ancrable par Haiku | → `needs_review` (humain) | → 1 passe Opus (si récupérable) **puis** re-gate ; sinon `needs_review` |
| Garantie zéro-fabrication | gate `evaluate()` | **gate inchangé** + ré-évalué après escalade (jamais relâché) |
| Priorité GS1 | GS1 gagne (lot/DLC/poids/GTIN) | **inchangé** ; un conflit code-barres↔imprimé n'est *pas* escaladé |
| Observabilité | logs extraction | **+** `llm_cache_usage`, `llm_escalation_total{reason}`, `llm_escalation_resolved_total`, `evidence_gate_reject_total` |

Décision de modèle d'escalade : **`claude-opus-4-8`** (SYNTHESIS **C12** — supplante le
`claude-sonnet-4-6` du brouillon CLAUDE.md).

---

## 1. Coût

Le gain de coût a **deux composantes opposées** ; il faut les distinguer pour ne pas surpromettre.

### 1.1 Cache de prompt — le vrai levier sur le chemin commun
Le préfixe statique (instructions + schéma + few-shot, ~4–5k tokens *[à mesurer]*) est désormais
**caché**. Sur un *hit*, Anthropic le facture à **~0,1×** au lieu de 1×. La partie volatile (texte
OCR + indice GS1) reste après le breakpoint, donc le préfixe est **identique d'un label à l'autre**.

Ordre de grandeur, Haiku ($1/1M en entrée), préfixe ~4 500 tokens *(illustratif, [à mesurer])* :

| | Tokens préfixe facturés | Coût/appel |
|---|---|---|
| Sans cache (ancien comportement) | 4 500 × 1× | ~$0,0045 |
| **Hit de cache** (régime établi) | 4 500 × 0,1× | **~$0,00045** |
| Écriture de cache (1er appel de la fenêtre, TTL 1h ≈ 2×) | 4 500 × 2× | ~$0,009 (une fois/fenêtre) |

→ **Rentabilité dès ~3 labels par fenêtre** (TTL `1h`) ; au-delà, ~90 % d'économie sur la portion
préfixe. **Nuance importante :** l'entrée n'est pas le poste dominant — la **sortie** (tableaux
`evidence`) l'est. Le cache ne « divise pas la facture par 10 » ; il rend **abordable un prompt riche
et détaillé** (meilleure extraction) au prix d'un petit prompt. Le vrai gain coût du cache = *qualité
de gros prompt, coût d'entrée de petit prompt sur les hits*.

### 1.2 Escalade — un arbitrage borné, pas une réduction aveugle
Opus 4.8 coûte **~5× Haiku**. L'escalade **n'est PAS** appliquée à chaque label : seulement quand le
résultat primaire gaté **forcerait `needs_review`** sur un champ **texte-libre requis** non fourni par
GS1, **au plus une fois par ingestion**. Sur la **majorité** des labels (faciles), le coût est
**inchangé** (Haiku + préfixe caché). Sur la **minorité dure récupérable**, on **déplace** le coût :
de la file de revue humaine (temps analyste HACCP) vers **un appel Opus borné**.

> **Verdict coût honnête.** Chemin commun : **neutre à légèrement moins cher** (cache). Chemin dur :
> **surcoût borné** (Opus sur la minorité) qui **remplace du temps humain**. Le bilan net dépend du
> **taux de cas durs** — donc **à mesurer** avant prod (et confirmer RPM/TPM Haiku+Opus, *flag B5*).
> Ce n'est pas une baisse de coût générale : c'est un coût quasi-stable sur le commun + un achat de
> qualité ciblé sur le dur.

---

## 2. Rapidité (latence)

### 2.1 Cache → TTFT bas **malgré** un prompt plus gros
Sans cache, prétraiter ~4,5k tokens de préfixe à chaque appel ajouterait de la latence (le prompt a
grossi). Avec le cache, sur un *hit* le préfixe est **servi depuis le cache** : le prétraitement de
cette portion est ~nul → **TTFT bas**. Net vs ancien (petit prompt) : **comparable sur les hits**,
alors qu'on a un prompt beaucoup plus riche. Sans le cache, la nouvelle version serait *plus lente*.

### 2.2 Escalade → +1 appel sur les cas durs, mais borné et asynchrone
Un cas escaladé fait **2 appels séquentiels** (Haiku puis Opus, Opus plus lent) → plus lent **pour ce
label**. Mais :
- l'extraction tourne **hors du chemin requête** (worker async) → le SLO `POST /v1/ingestions`
  p95 < 1,5 s **n'est pas affecté** ;
- le budget fournisseur reste **borné** (≤ 3 tentatives, 120 s ; l'appel d'escalade compte dedans) ;
- le SLO de fraîcheur (p95 soumission→extraction < 60 s) a de la marge pour un appel de plus ;
- surtout : l'alternative pour ces cas était la **revue humaine** (minutes→heures). Pour un cas dur
  *récupérable*, le **temps jusqu'à un résultat `extracted` exploitable chute** (secondes vs attente
  d'un analyste).

> **Verdict rapidité.** Chemin commun : **neutre à meilleur** (cache absorbe le gros prompt). Chemin
> dur : **+1 appel Opus** (secondes, async, borné) qui **convertit une attente humaine en résultat
> automatique**. Le temps de résolution bout-en-bout des cas durs récupérables **s'améliore nettement**.

---

## 3. Zéro hallucination

C'est le gain **le plus net** — et le plus important pour un système HACCP.

- **Le gate reste l'unique frontière de confiance, et n'est JAMAIS relâché.** La sortie escaladée
  repasse par le **même** `evaluate()` (anti-fabrication : toute valeur non ancrée dans l'OCR brut →
  `null`). On ré-évalue le set fusionné une fois ; on ne ré-implémente ni n'assouplit le gate.
- **Le gros prompt statique réduit la fabrication *en amont*.** Règles de non-fabrication explicites
  + guidage par champ + few-shot fidèles → le modèle **primaire ancre mieux et invente moins**, donc
  **moins de rejets** du gate et **moins de `needs_review`**.
- **L'escalade *récupère* des valeurs réelles, elle n'*invente* pas.** Quand Haiku rend un champ
  requis en faible confiance/`null` **alors que la valeur EST dans l'OCR**, Opus (plus capable)
  l'ancre avec une *evidence* réelle. La fusion garde le **meilleur des deux ancrés** (plus haute
  `combined_confidence`) ; un champ qu'**aucun** modèle n'ancre **reste `null`** et part en
  `needs_review`. C'est l'**inverse** d'une hallucination.
- **GS1 garde la priorité.** Lot/DLC/poids/GTIN restent fournis par le code-barres (confiance 1.0).
  Un **conflit code-barres↔imprimé** sur lot/DLC est une **vraie anomalie** : il **n'est pas
  escaladé** (un 2ᵉ LLM ne doit pas « réparer » un désaccord de données) → reste `needs_review`.
- **Nouvelle visibilité sur les tentatives de fabrication.** `evidence_gate_reject_total` s'incrémente
  quand le gate coerce une *evidence* fabriquée en `null` (`EVIDENCE_NOT_IN_RAW_OCR`) ; rien
  n'émettait ce signal avant. Avec `llm_escalation_resolved_total`, on voit combien de futurs
  `needs_review` ont été **récupérés sans inventer**.

> **Verdict zéro-hallucination.** La garantie est **préservée par construction** (gate intact,
> ré-évaluation, GS1 gagne). En plus : **moins de tentatives** de fabrication (meilleur prompt),
> **récupération de valeurs réelles** (escalade), et **observabilité** des fabrications. Aucun
> compromis : c'est strictement ≥ l'ancien.

---

## 4. Les tests à faire

### 4.1 Déjà automatisés (offline, dans la suite — `pytest`)
Tournent sans réseau ni dépense (fakes déterministes + PG éphémère). Ce qu'ils **prouvent** :

**Escalade** — [`tests/test_extraction_escalation.py`](../server/tests/test_extraction_escalation.py) :
- `test_flag_off_no_escalation_still_needs_review` — **flag OFF ⇒ comportement inchangé** : la 2ᵉ
  instance est injectée mais **jamais appelée** ; un champ requis faible reste `needs_review`.
- `test_flag_on_recovers_free_text_field_to_extracted` — flag ON : champ texte-libre requis ambigu,
  primaire le rend en faible confiance **mais présent dans l'OCR** ⇒ escalade **exactement une fois**,
  ré-évaluée, champ ancré, run passe à **`extracted`** au lieu de `needs_review`,
  `llm_escalation_resolved_total` émis.
- `test_lot_dlc_conflict_does_not_escalate` — conflit lot/DLC code-barres↔imprimé ⇒ **pas d'escalade**,
  reste `needs_review`.
- `test_gs1_field_not_overridden_by_escalation` — un champ GS1 garde `source='gs1'` / confiance 1.0
  même quand l'escalade tourne pour un autre champ.
- `test_same_model_never_called_twice_for_one_ingestion` — dedup `(ingestion, modèle)` : si le modèle
  d'escalade = modèle primaire, l'artefact existant **court-circuite** le 2ᵉ appel.

**Cache** — [`tests/test_prompt_cache.py`](../server/tests/test_prompt_cache.py) :
- préfixe caché **ne contient aucune** donnée dynamique/secret (texte OCR, indice GS1,
  `correlation_id`, `trace_id`, timestamp horloge) ;
- texte OCR + indice GS1 vivent dans le message **dynamique** (pas dans le préfixe) ;
- breakpoint `cache_control` posé en fin de bloc système **quand le flag est ON**, **absent** quand OFF ;
- les compteurs `cache_creation_input_tokens` / `cache_read_input_tokens` sont **journalisés** (métrique
  allow-listée, jamais le contenu du prompt).

**Régression** — toute la suite PG-4 existante (consumer, GS1, réconciliation, Option Y, immuabilité,
outbox/DLQ) **doit rester verte** : c'est la preuve « flag OFF = pas de changement de comportement »
(faute de baseline git, `server/` n'étant pas commité).

**Comment lancer :** `bash server/scripts/run_local_proofs.sh` (PG éphémère + `alembic upgrade head`
+ `lint-imports` G-ARCH + `pytest`). État de référence v0010 : **184 passés, 1 skip**, `lint-imports`
**5/5 KEPT**, migration `0010` réversible (down/up vérifié).

### 4.2 Nécessitent l'API live (credentials `ANTHROPIC_API_KEY`)
Skippés en CI sans clé ; **à lancer manuellement** avant d'activer le cache en prod :
- **Plancher de cache Haiku ≥ 4096 tokens** — `test_static_prefix_meets_haiku_4096_floor`
  (skip sans clé) **ou** le script [`scripts/measure_prompt_tokens.py`](../server/scripts/measure_prompt_tokens.py).
  *Pourquoi :* sous 4096, Haiku **ne cache jamais** silencieusement (`cache_creation_input_tokens=0`).
- **Cache réellement lu (cassette/2 appels live)** — deux appels partageant le préfixe dans le TTL :
  le 1ᵉʳ doit reporter `cache_creation_input_tokens > 0`, le 2ᵉ `cache_read_input_tokens > 0`.
  *Si le 2ᵉ reste à 0 → un invalidateur silencieux s'est glissé dans le préfixe.*

### 4.3 Validation staging **avant** prod (mesures réelles, pas des fakes)
1. **Activer `LABELSCAN_LLM_ESCALATION_ENABLED=true` en staging uniquement.**
2. **A/B vs baseline** (ce qui valide les §1–§3) :
   - **taux de `needs_review`** : doit **baisser** (cas durs récupérés) sans hausse des faux-`extracted` ;
   - **confiance par champ** (`combined_confidence`) : distribution ≥ baseline sur les champs texte-libre ;
   - **`llm_escalation_total` / `llm_escalation_resolved_total`** : combien de runs escaladés, combien
     **résolus** (ratio = efficacité réelle de l'escalade) ;
   - **`evidence_gate_reject_total`** : tendance des tentatives de fabrication (doit rester basse/stable).
3. **Coût (§1)** : coût/label réel (Haiku caché) + **part** des labels escaladés × surcoût Opus ;
   re-mesurer les tokens avec `count_tokens` (pas d'estimation tiktoken).
4. **Latence (§2)** : hit-rate de cache + **fraîcheur p95** (submit→extraction) ; vérifier la marge
   sous 60 s avec l'appel d'escalade sur les cas durs.
5. **Capacité (flag B5)** : confirmer **RPM/TPM Haiku ET Opus** pour le palier du compte — l'escalade
   ajoute des appels tier-2 sur les cas durs et **ne doit pas** déclencher de rate-limit.

### 4.4 Ce qui n'est **pas** testable automatiquement (à acter)
- « flag OFF = byte-for-byte identique à main » : **pas de baseline git** (`server/` non commité) → on
  prouve l'identité **comportementale** (escalade jamais appelée, même issue `needs_review`), pas un diff.
- Le **vrai** taux de hit de cache et la **vraie** baisse de `needs_review` ne se voient qu'avec du
  trafic réel (§4.3) — les tests offline prouvent la *mécanique* (breakpoint envoyé, usage journalisée,
  re-gate), pas l'effet statistique.

---

## Ordre de déploiement (rappel)
1. Prompts 0–2 → déployer le cache, surveiller hit-rate + fraîcheur p95.
2. Prompts 3–6 → merger avec escalade **OFF**.
3. Activer l'escalade **en staging uniquement** ; comparer `needs_review` + confiance vs baseline avant
   la prod.
4. Avant dimensionnement prod : confirmer RPM/TPM Haiku & Opus (flag B5).
