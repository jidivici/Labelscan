# LabelScan — Script de présentation **backend** (jury d'experts)

**Public :** jury d'experts (ingénieurs, architectes, évaluateurs techniques).
**Durée :** 13–15 minutes · 12 diapos.
**Objet :** défendre l'**architecture backend** — ses garanties dures et ses arbitrages.
**Posture :** technique et dense, mais **chaque terme est défini** (encadrés 💡 + lexique final),
car « expert » ne veut pas dire « connaît exactement cette stack ».
**Format :** ⏱️ durée · 🖥️ écran · 🗣️ texte à dire · 💡 jargon expliqué.
**Rythme :** ~140 mots/minute.

> **Stack à afficher en bandeau permanent :** Python 3 · FastAPI · Pydantic (frontière) ·
> SQLAlchemy/psycopg · Alembic · PostgreSQL 16 · Google Vision (OCR) · Claude Haiku 4.5 (LLM) ·
> Docker Compose (db + server + 2× worker).

---

## Diapo 1 — Titre & thèse · ⏱️ 0:45 (cumul 0:45)

🖥️ *« LabelScan — Architecture backend. Traçabilité HACCP des produits de la mer. » + bandeau stack.*

🗣️
« Bonjour. LabelScan est un système de traçabilité HACCP pour la poissonnerie de grande distribution : une photo d'étiquette devient une donnée structurée, vérifiée, auditable.

Je ne vais pas vous parler de l'interface. Je vais défendre le **backend**, et une thèse précise : il tient **simultanément quatre promesses** difficiles à concilier — **ne jamais inventer une donnée**, **garder une mémoire infalsifiable**, **ne jamais perdre une capture**, et **rester remplaçable pièce par pièce**. Et surtout : ces garanties ne sont pas des promesses applicatives — elles sont posées au **niveau structurel**, là où on ne peut pas les contourner. »

💡 **Backend** = la partie serveur (logique, données, intégrations), par opposition au client mobile.
💡 **Garantie structurelle** = imposée par la structure (base de données, types, CI), pas seulement par du code applicatif qu'on espère correct.

---

## Diapo 2 — Le cahier des charges : 8 contraintes non-négociables · ⏱️ 1:15 (cumul 2:00)

🖥️ *Liste des 8 contraintes, numérotées.*

🗣️
« Tout part de huit contraintes non-négociables du cahier des charges. Les voici :

1. Ne **jamais halluciner** de donnée réglementaire ni inventer un champ manquant — inconnu vaut **null**.
2. Chaque champ extrait porte un **score de confiance** et sa **provenance**.
3. La donnée **brute** est stockée **avant** toute normalisation.
4. Tout changement métier est **auditable** ; l'historique est **immuable**.
5. Le **domaine** ne dépend ni du framework, ni de la base, ni du HTTP, ni des fournisseurs OCR/LLM.
6. OCR et LLM doivent être **remplaçables** via ports & adapters.
7. Décisions **réversibles** plutôt qu'optimales-mais-rigides ; arbitrages nommés.
8. **correlation_id** et **trace_id** partout.

Ma colonne vertébrale aujourd'hui, c'est ça : pour chaque décision d'architecture, je la relie à l'une de ces contraintes. »

💡 **Normalisation** = transformer une valeur en forme canonique (date → ISO, °F → °C).
💡 **null** = l'absence explicite de valeur (« non renseigné »), distincte d'une valeur vide ou inventée.
💡 **correlation_id / trace_id** = identifiants qui suivent une même requête à travers tous les composants, pour la relier dans les logs.

---

## Diapo 3 — Style architectural : monolithe modulaire + hexagonal + DDD · ⏱️ 1:30 (cumul 3:30)

🖥️ *Schéma en oignon : `adapters → application → domain` (flèches vers l'intérieur). Tampon « import-linter / CI ».*

🗣️
« Le style : un **monolithe modulaire**, **hexagonal**, avec du **DDD tactique** dans les cœurs métier.

Monolithe modulaire et pas microservices, parce que l'équipe est petite, que les frontières métier émergent encore, et qu'on a besoin de **cohérence forte** entre ingestion et audit. On garde un seul déployable, mais découpé en modules étanches : extraire un service plus tard se fait **le long d'une couture existante**, sans réécriture.

Hexagonal, ça veut dire une **loi de dépendance** stricte : `adapters → application → domain`, **jamais l'inverse**. Le domaine — les règles métier pures — ne connaît ni FastAPI, ni SQL, ni Google, ni Claude. Les fournisseurs sont au bout, derrière des **ports**.

Et ce n'est pas une convention qu'on espère respecter : c'est **vérifié en intégration continue** par `import-linter`, avec quatre contrats — le respect des couches, l'indépendance des contextes, la pureté du domaine, la pureté de l'application. À la moindre violation d'import, **le build casse**. »

💡 **Monolithe modulaire** = un seul exécutable déployable, structuré en modules à frontières strictes.
💡 **Architecture hexagonale / ports & adapters** = le cœur métier définit des **interfaces** (ports) ; les outils concrets (base, OCR, LLM) sont des **adapters** branchés dessus et interchangeables.
💡 **Domaine** = le code des règles métier pures, sans aucune dépendance technique.
💡 **DDD (tactique)** = Domain-Driven Design : modéliser le code avec le vocabulaire métier (agrégats, événements…).
💡 **import-linter / CI** = un outil qui interdit certains imports entre modules ; la CI (intégration continue) rejoue ces règles à chaque commit.

---

## Diapo 4 — Six contextes, intégration par événements · ⏱️ 1:15 (cumul 4:45)

🖥️ *6 blocs : Ingestion (cœur), HACCP (cœur), Traçabilité, Conformité, Audit, Identité — reliés par des flèches « événements ».*

🗣️
« Le domaine est découpé en **six contextes délimités**. Deux **cœurs** — l'Ingestion-Extraction et les Contrôles HACCP, là où vit la vraie complexité — et quatre contextes support ou génériques : Traçabilité, Conformité, Audit, Identité.

Point capital : **un contexte n'importe jamais un autre**. Ils s'intègrent uniquement par **événements de domaine publiés** et par **identifiants**. Conséquence concrète : l'Ingestion **ne peut pas**, physiquement, appeler l'Extraction ou la Traçabilité — le lien passe par un événement. Le HACCP **réagit** à un événement « lot enregistré », il ne va pas chercher la donnée lui-même.

C'est du **découplage par construction, pas par discipline** — et là encore, l'indépendance des contextes est un contrat vérifié par `import-linter`. »

💡 **Contexte délimité (bounded context)** = un sous-domaine métier autonome, avec son propre modèle et son propre vocabulaire.
💡 **Événement de domaine** = un message décrivant un fait métier survenu (« lot enregistré »), que d'autres contextes peuvent consommer.
💡 **Couplage** = degré de dépendance entre modules ; ici on le minimise pour pouvoir faire évoluer chaque contexte isolément.

---

## Diapo 5 — Intégrité au niveau base : append-only + audit infalsifiable · ⏱️ 1:45 (cumul 6:30)

🖥️ *Deux déclencheurs SQL : `deny_mutation` (BEFORE UPDATE/DELETE/TRUNCATE) et `audit_on_insert` (AFTER INSERT, SECURITY DEFINER).*

🗣️
« Voici la pièce dont je suis le plus fier, parce qu'elle répond aux contraintes 3 et 4 **au bon endroit** : dans **PostgreSQL lui-même**, pas dans le code applicatif.

Premier déclencheur : `deny_mutation`. Il est posé sur les tables **append-only** — la donnée brute, les relevés de température, le journal d'audit. Il se déclenche **avant** tout UPDATE, DELETE ou TRUNCATE, et il **lève une erreur pour tout le monde** — y compris le propriétaire de la table et le super-utilisateur. Autrement dit : un enregistrement historique est immuable **quel que soit le privilège**. En défense en profondeur, le rôle applicatif s'est en plus vu **retirer** les droits UPDATE/DELETE.

Deuxième déclencheur : `audit_on_insert`. À chaque INSERT sur une table métier auditée, il écrit **exactement une** ligne d'audit, **dans la même transaction**, en lisant l'acteur et les identifiants de corrélation depuis des **réglages locaux à la transaction**. Si ce contexte d'audit est absent, il **lève une erreur et annule l'insertion**. Et comme le rôle applicatif n'a **aucun** droit d'INSERT direct sur le journal d'audit, une entrée ne peut exister **que** via ce déclencheur : l'audit est donc **infalsifiable**.

La leçon d'architecture : un co-commit d'audit géré en applicatif peut être contourné par n'importe quelle écriture SQL directe. **Un déclencheur en base, non.** »

💡 **Déclencheur (trigger)** = du code SQL exécuté automatiquement par la base à un événement (avant/après un INSERT, un UPDATE…).
💡 **Append-only** = table en ajout seul : INSERT autorisé, UPDATE/DELETE/TRUNCATE interdits.
💡 **TRUNCATE** = commande qui vide une table d'un coup (ici, bloquée).
💡 **Principal / super-utilisateur** = l'identité qui exécute la requête ; le super-utilisateur a normalement tous les droits — ici même lui est bloqué.
💡 **SECURITY DEFINER** = le déclencheur s'exécute avec les droits de **son propriétaire** (un rôle d'audit minimal), pas de l'appelant — ce qui empêche de forger ou d'éviter l'audit.
💡 **Réglage local à la transaction** = une variable valable seulement le temps de la transaction (qui a fait l'action), lue par le déclencheur.
💡 **Défense en profondeur** = empiler plusieurs protections indépendantes (droits retirés **et** déclencheur).
💡 **Partitionnement** = les tables append-only sont découpées par mois (partition par plage de dates) pour rester performantes à grande échelle ; l'audit référence toujours la table logique parente, jamais la partition physique.

---

## Diapo 6 — Ingestion durable : raw-before-ack & idempotence · ⏱️ 1:15 (cumul 7:45)

🖥️ *Séquence : `sha256` → écriture brute (fsync) → 1 transaction auditée → 202.*

🗣️
« L'écriture d'une capture suit un contrat de **durabilité** précis. Quatre temps :

D'abord on **hache** les octets de l'image en SHA-256. Ensuite — **avant toute ligne en base** — on persiste l'image brute de façon durable : écriture dans un fichier temporaire, **fsync**, **renommage atomique**, puis fsync du répertoire. Donc les octets survivent à un crash **avant même** qu'une ligne existe. Puis on écrit l'ingestion et l'artefact brut dans **une seule transaction auditée**. Et on ne renvoie un **202 Accepted** qu'**après le commit**.

L'**idempotence** est ancrée sur le **hash de contenu** : une revendication atomique `INSERT … ON CONFLICT DO NOTHING`. Un envoi en double renvoie l'identifiant existant et **n'écrit rien**. La photo brute existe donc avant tout le reste — c'est la preuve d'origine, posée **avant l'accusé de réception**. »

💡 **SHA-256 / hash de contenu** = empreinte numérique unique des octets ; deux images identiques ont le même hash (sert de clé d'idempotence).
💡 **fsync** = force l'écriture physique sur le disque (sinon le système peut garder en cache et tout perdre au crash).
💡 **Renommage atomique** = opération « tout ou rien » qui rend le fichier visible d'un coup, jamais à moitié écrit.
💡 **Transaction** = un groupe d'écritures « tout ou rien » : soit tout est validé (commit), soit rien.
💡 **202 Accepted** = réponse HTTP « reçu et accepté, traitement en cours » (l'extraction se fera ensuite).
💡 **Idempotence** = rejouer la même opération produit le même résultat, sans doublon.

---

## Diapo 7 — Découplage durable : outbox transactionnel + worker · ⏱️ 1:30 (cumul 9:15)

🖥️ *`ingestion + outbox` (même transaction) → relay worker `FOR UPDATE SKIP LOCKED` → consumers → `processed_event`.*

🗣️
« Comment l'ingestion (synchrone, rapide) et l'extraction (lente, faillible) restent-elles **strictement découplées** ? Par un **outbox transactionnel**.

Quand l'ingestion réussit, l'événement « brut stocké » est inséré dans la table outbox **dans la même transaction** que l'ingestion. Donc l'événement existe **si et seulement si** l'ingestion a été validée : **aucun événement perdu, aucun événement fantôme**.

Un **relay worker** réclame ensuite les lignes **une par une** avec `FOR UPDATE SKIP LOCKED` — ce qui est sûr avec **plusieurs workers en parallèle** : on en fait tourner deux. Une transaction par ligne.

La livraison est **at-least-once** et les consommateurs sont **idempotents** : chaque couple (consommateur, événement) est noté dans une table `processed_event`. Un crash avant le commit ? La ligne revient « non publiée », donc **rejouée**. Une redélivrance d'un événement déjà traité ? **Ignorée** — aucun effet de bord en double. Et un message « poison » qui échoue en boucle finit en **file de rebut (DLQ)** avec **backoff**. »

💡 **Transactional outbox** = motif où l'on écrit l'événement dans la même transaction que la donnée métier, garantissant leur cohérence.
💡 **Relay worker** = un processus de fond qui lit l'outbox et déclenche les traitements.
💡 **FOR UPDATE SKIP LOCKED** = verrou SQL qui permet à plusieurs workers de se partager la file sans se marcher dessus (chacun saute les lignes déjà prises).
💡 **At-least-once** = chaque événement est livré au moins une fois (donc potentiellement plusieurs) — d'où la nécessité de consommateurs idempotents.
💡 **Effet de bord** = toute action observable (écrire en base, appeler un fournisseur payant) ; on évite de la rejouer en double.
💡 **DLQ (Dead-Letter Queue) / backoff** = file de rebut pour les messages qui échouent toujours ; le backoff espace les nouvelles tentatives.

---

## Diapo 8 — Le pipeline d'extraction & la frontière de confiance · ⏱️ 1:45 (cumul 11:00)

🖥️ *`charger image → OCR → LLM → GATE → persister`. Le GATE marqué « TRUST BOUNDARY ».*

🗣️
« Le consommateur d'extraction enchaîne : charger l'image → **OCR** → **LLM** → **gate de domaine** → persister. Deux mécanismes le rendent digne de confiance.

**Un — déduplication des appels externes.** L'OCR et le LLM tournent chacun dans **leur propre transaction validée**, et stockent leur sortie brute comme **artefact immuable**. Sur une nouvelle tentative, l'artefact **existe déjà** : le fournisseur **n'est pas rappelé**. Pas de double facturation, effet **exactly-once** côté fournisseur.

**Deux — le gate anti-fabrication**, du **domaine pur**, et c'est la **frontière de confiance** du système. Toute valeur non-nulle doit avoir une **preuve** (`evidence`) qui est une **sous-chaîne, mot pour mot, du texte OCR brut**. Sinon, la valeur est **forcée à null** et marquée `EVIDENCE_NOT_IN_RAW_OCR`. Chaque valeur stockée porte sa **provenance** — identifiant d'artefact + position (page, offset) — et c'est garanti par une **contrainte CHECK** en base : `value IS NULL OR provenance IS NOT NULL`. On **ne peut pas** stocker une valeur sans provenance.

Détail important : la sortie structurée du LLM garantit la **forme**, pas la **vérité**. Le gate ne fait jamais confiance au modèle — il **revérifie** indépendamment. La confiance finale est **composite** : un **plancher OCR** multiplie la confiance LLM recalibrée, et le statut de validation peut **plafonner** le tout. Enfin, tout est **append-only** : une ré-extraction est un **nouveau run** (`attempt_no` incrémenté), les précédents restent immuables. »

💡 **Pipeline** = chaîne de traitements successifs.
💡 **OCR / LLM** = reconnaissance de texte sur image / modèle de langage (ici Google Vision et Claude Haiku 4.5).
💡 **Gate (frontière de confiance)** = point de contrôle unique où la sortie du modèle est validée avant d'être acceptée.
💡 **evidence (preuve) / sous-chaîne verbatim** = la portion exacte du texte OCR qui justifie la valeur ; si elle n'y figure pas mot pour mot, la valeur est rejetée.
💡 **Coercition à null** = remplacement automatique d'une valeur non justifiée par « non renseigné ».
💡 **Provenance** = origine traçable d'une valeur (quel artefact, quelle position).
💡 **Contrainte CHECK** = règle d'intégrité imposée par la base, impossible à violer depuis l'application.
💡 **Sortie structurée (structured output)** = le LLM est contraint de répondre selon un schéma JSON strict — garantit la forme, pas l'exactitude.
💡 **exactly-once** = un effet (ici l'appel fournisseur) ne se produit qu'une fois, même en cas de rejeu.
💡 **Recalibration / plancher** = ajustement du score de confiance ; un OCR illisible plafonne la confiance même si le LLM est « sûr ».

---

## Diapo 9 — Extraction hybride : GS1 déterministe + réconciliation · ⏱️ 1:15 (cumul 12:15)

🖥️ *`GS1 (exact, conf. 1.0)` ⊕ `LLM (gated)` → `reconcile()` → champs persistés. Encadré « GS1 gagne ».*

🗣️
« L'extraction est **hybride**, et c'est une décision de conception, pas un détail. Le code-barres professionnel — **GS1-128** ou **DataMatrix** — est décodé par du **domaine pur** en ses **Application Identifiers** : 01 = GTIN, 10 = lot, 17 = date limite de consommation, 310x = poids net. Cette donnée vient de la **symbologie**, elle est **mathématiquement exacte** : elle **contourne légitimement** le gate de grounding OCR, parce que sa preuve n'est pas le texte, c'est le code-barres lui-même.

La fonction `reconcile()` fusionne les champs LLM validés et les champs GS1. **En cas de conflit, le GS1 gagne** — lot, date, poids, GTIN, à confiance 1.0 — et la valeur LLM perdante est **conservée dans un avertissement**, jamais supprimée en silence.

Et un garde-fou métier : un **conflit code-barres ↔ imprimé** sur un champ critique — lot ou DLC — **force la revue humaine** (`needs_review`). C'est une **anomalie d'étiquetage** qu'un humain doit voir. Enfin, la réconciliation **ne relâche jamais** le verdict du gate : si le modèle a halluciné, ça reste bloquant **même si** le GS1 a corrigé la valeur stockée. »

💡 **GS1-128 / DataMatrix** = standards de codes-barres professionnels (linéaire / 2D) qui encodent plusieurs champs.
💡 **Application Identifier (AI)** = préfixe normalisé qui dit quel champ suit (01 = GTIN, 10 = lot, 17 = DLC…).
💡 **GTIN** = identifiant article international (le « numéro de produit »).
💡 **DLC / DDM** = date limite de consommation (AI 17) / date de durabilité minimale (AI 15) ; on privilégie la DLC, plus critique.
💡 **Symbologie** = la façon dont le code-barres encode l'information ; lecture exacte, sans interprétation.
💡 **Réconciliation** = fusion arbitrée de deux sources selon des règles de priorité.
💡 **needs_review** = statut « à vérifier par un humain » ; aucune acceptation automatique.

---

## Diapo 10 — Domaine métier : traçabilité & HACCP · ⏱️ 1:15 (cumul 13:30)

🖥️ *Chaîne `produit → fournisseur → lot → run d'extraction → ingestion → artefact brut`. Machine à états d'alerte.*

🗣️
« Sur une extraction **validée**, le contexte **Traçabilité** enregistre la **chaîne complète** : produit → fournisseur → lot → run d'extraction source → ingestion source → artefact brut. Tout en append-only, tout relié par **identifiant** entre contextes. Une donnée incohérente — fournisseur qui ne correspond pas, dates impossibles — produit un **lot signalé** (flagged), jamais une correction silencieuse.

Le contexte **HACCP** fait tourner un **moteur de règles pur** qui évalue les **points de contrôle critiques** contre un **plan de contrôle versionné** — les seuils sont des **données détenues par la Conformité**, jamais codés en dur. Il lève des alertes d'**expiration**, d'**incohérence**, et de **température** (avec relevé immuable).

Les **alertes** sont le **seul agrégat mutable** du système : une **machine à états** `ouverte → acquittée → résolue`, codée dans le domaine, **auditée à chaque transition**. Une transition invalide est rejetée — pas de changement d'état, pas de ligne d'audit pour la tentative. Et si un fournisseur échoue : après la **limite de tentatives**, on enregistre un run **FAILED** et on consomme l'événement — **pas de boucle infinie**. »

💡 **Agrégat (DDD)** = un groupe d'objets traité comme une unité cohérente, avec ses règles d'intégrité.
💡 **Machine à états** = un objet qui ne peut passer que par des transitions autorisées (ici ouverte → acquittée → résolue).
💡 **Point de contrôle critique (CCP)** = étape où un risque sanitaire doit être maîtrisé (date, température…).
💡 **Plan de contrôle versionné** = l'ensemble des seuils en vigueur, daté et immuable, pour qu'une alerte reste explicable par le plan actif au moment des faits.
💡 **Moteur de règles** = code qui applique des règles métier à des données pour produire un verdict.
💡 **Lot signalé (flagged)** = lot enregistré mais marqué incohérent, en attente d'examen.

---

## Diapo 11 — API & observabilité · ⏱️ 1:15 (cumul 14:45)

🖥️ *Adapter HTTP fin · réponses `application/problem+json` · `correlation_id`/`trace_id` à travers le saut asynchrone · SLOs.*

🗣️
« La couche HTTP, ce sont des **adapters fins** au-dessus des cas d'usage — **zéro logique métier**. Validation de transport à la frontière : en-tête `Idempotency-Key` obligatoire, type de média, taille. Les erreurs sont normalisées en **RFC 9457**, `application/problem+json`, avec un **catalogue de codes d'erreur** stables, plus les identifiants de corrélation et de trace.

L'authentification est par **JWT** avec des **scopes par endpoint**, en **fail-closed** : les endpoints de lecture utilisent des scopes de lecture, jamais le scope d'écriture.

Côté observabilité : `correlation_id` et `trace_id` sur **chaque** enveloppe d'événement et **chaque** ligne de log, **à travers le saut asynchrone** ingestion → worker. Le formateur de logs JSON a une **liste blanche stricte** — secrets et données personnelles **ne peuvent pas** fuiter dans les logs. Et on suit des **SLO** : fraîcheur d'extraction **p95 sous 60 s**, succès ≥ 95 % sous 5 minutes, calibration **ECE ≤ 0,10**, avec **détection de dérive** sur les taux de null et d'ambigu. »

💡 **Adapter fin** = couche de traduction HTTP↔cas d'usage, sans règle métier (testable, remplaçable).
💡 **RFC 9457 / problem+json** = format standard de réponse d'erreur HTTP, lisible par machine.
💡 **Catalogue de codes d'erreur** = liste stable et documentée d'identifiants d'erreur (le client peut s'y fier).
💡 **JWT (JSON Web Token)** = jeton signé qui prouve l'identité de l'appelant.
💡 **Scope** = permission fine attachée à un jeton (lire les alertes, écrire une ingestion…).
💡 **Fail-closed** = en cas de doute sur les droits, on **refuse** par défaut (sécurité).
💡 **Saut asynchrone** = le passage du traitement de la requête HTTP au worker de fond ; on y propage les identifiants de trace.
💡 **SLO / p95** = objectif de niveau de service ; « p95 < 60 s » = 95 % des extractions en moins de 60 s.
💡 **ECE (Expected Calibration Error)** = mesure de la fiabilité des scores de confiance (un score de 0,8 doit être juste ~80 % du temps).
💡 **Dérive (drift)** = évolution silencieuse de la distribution des données dans le temps, à détecter avant qu'elle ne dégrade la qualité.

---

## Diapo 12 — Décisions tracées, réversibles (ADRs) & synthèse · ⏱️ 1:15 (cumul 16:00)

🖥️ *Les 7 ADRs en liste + chiffres de clôture.*

🗣️
« Pour finir : chaque choix structurel est un **ADR** — contexte, décision, conséquences, **arbitrages**, **réversibilité**. Sept d'entre eux : monolithe modulaire ; ports pour OCR/LLM ; brut-avant-normalisé ; audit append-only plutôt qu'event-sourcing ; confiance portée par le champ ; DDD tactique seulement dans les cœurs ; Python/FastAPI.

Le fil rouge est constant : **les garanties dures sont posées à la couche la plus basse possible**, les arbitrages sont **nommés**, et chaque décision est **réversible** — au point que la CI rejoue les migrations **montée → descente → montée** pour prouver la réversibilité du schéma.

En chiffres : ~6 400 lignes de Python côté serveur, **11 migrations** réversibles, **6 contextes**, des **centaines de tests** automatisés (dont 69 « preuves » d'intégrité), une CI qui valide la frontière d'architecture et la réversibilité.

La thèse, prouvée : un système de conformité où **l'intégrité n'est pas une promesse applicative — c'est une propriété structurelle**. Merci, je prends vos questions. »

💡 **ADR (Architecture Decision Record)** = note courte qui fige une décision, ses raisons, ses compromis et comment revenir en arrière.
💡 **Réversibilité** = capacité à annuler une décision ou une migration sans casse.
💡 **Couture (seam)** = ligne de séparation propre le long de laquelle on pourra extraire un module en service plus tard.
💡 **Event-sourcing** = alternative (écartée ici) où l'état est reconstruit à partir du flux d'événements ; jugée trop complexe pour le besoin actuel.
💡 **Migration (montée/descente)** = script versionné qui fait évoluer le schéma de base ; « descente » = le rollback, testé en CI.

---

## 📕 Lexique express (carte de secours pour les questions)

| Terme | En une phrase |
|---|---|
| **Backend** | La partie serveur : logique, données, intégrations. |
| **Monolithe modulaire** | Un seul déployable, découpé en modules étanches. |
| **Hexagonal / ports & adapters** | Cœur métier isolé ; outils externes interchangeables derrière des interfaces. |
| **Domaine** | Code des règles métier pures, sans dépendance technique. |
| **DDD / contexte délimité** | Modéliser par le métier ; sous-domaine autonome à frontière stricte. |
| **import-linter / CI** | Outil qui interdit les imports illégaux ; rejoué à chaque commit. |
| **Événement de domaine** | Message décrivant un fait métier, consommé par d'autres contextes. |
| **Déclencheur (trigger)** | Code SQL exécuté automatiquement par la base. |
| **Append-only** | Table en ajout seul (UPDATE/DELETE/TRUNCATE interdits). |
| **SECURITY DEFINER** | Déclencheur exécuté avec les droits de son propriétaire → audit infalsifiable. |
| **Défense en profondeur** | Empiler des protections indépendantes. |
| **Partitionnement** | Découper une table (par mois) pour la performance à grande échelle. |
| **SHA-256 / hash de contenu** | Empreinte unique des octets ; clé d'idempotence. |
| **fsync / renommage atomique** | Forcer l'écriture disque / rendre un fichier visible « tout ou rien ». |
| **Transaction / commit** | Groupe d'écritures tout-ou-rien. |
| **202 Accepted** | Réponse HTTP « accepté, traitement en cours ». |
| **Idempotence** | Rejouer une opération ne crée pas de doublon. |
| **Transactional outbox** | Écrire l'événement dans la même transaction que la donnée. |
| **Relay worker** | Processus de fond qui lit l'outbox et déclenche les traitements. |
| **FOR UPDATE SKIP LOCKED** | Verrou qui permet à plusieurs workers de se partager une file. |
| **At-least-once** | Livraison au moins une fois → consommateurs idempotents requis. |
| **DLQ / backoff** | File de rebut pour messages échoués / espacement des retentatives. |
| **OCR / LLM** | Lecture de texte sur image / modèle de langage (Vision, Claude Haiku). |
| **Gate / frontière de confiance** | Contrôle unique qui valide la sortie du modèle. |
| **evidence / sous-chaîne verbatim** | Portion exacte du texte OCR justifiant une valeur. |
| **Coercition à null** | Annulation auto d'une valeur non justifiée. |
| **Provenance** | Origine traçable d'une valeur (artefact + position). |
| **Contrainte CHECK** | Règle d'intégrité imposée par la base. |
| **Sortie structurée** | Réponse LLM contrainte à un schéma JSON (forme, pas vérité). |
| **exactly-once** | Un effet ne se produit qu'une fois malgré les rejeux. |
| **GS1-128 / DataMatrix** | Codes-barres pro encodant plusieurs champs. |
| **Application Identifier (AI)** | Préfixe normalisé désignant le champ (01 GTIN, 10 lot, 17 DLC). |
| **GTIN** | Identifiant article international. |
| **DLC / DDM** | Date limite de consommation / de durabilité minimale. |
| **Réconciliation** | Fusion arbitrée de deux sources (GS1 gagne). |
| **needs_review / flagged** | À vérifier par un humain / lot marqué incohérent. |
| **Agrégat / machine à états** | Unité métier cohérente / transitions d'état autorisées. |
| **CCP / plan de contrôle versionné** | Point de contrôle critique / seuils datés et immuables. |
| **RFC 9457 / problem+json** | Format standard d'erreur HTTP. |
| **JWT / scope / fail-closed** | Jeton d'identité / permission fine / refus par défaut. |
| **correlation_id / trace_id** | Identifiants qui relient une requête à travers tous les composants. |
| **SLO / p95** | Objectif de service / 95ᵉ percentile (95 % des cas sous le seuil). |
| **ECE** | Mesure de fiabilité des scores de confiance. |
| **Dérive (drift)** | Évolution silencieuse de la distribution des données. |
| **ADR / réversibilité** | Note de décision d'architecture / capacité de retour arrière. |
| **Event-sourcing** | Reconstruire l'état à partir des événements (écarté ici). |

---

## 🎯 Conseils face à un jury d'experts

- **Diapo 5 est votre pièce maîtresse.** Un jury technique teste l'intégrité : insistez sur « le déclencheur lève une erreur **même pour le super-utilisateur** » et « l'audit ne peut exister **que** via le déclencheur ».
- **Anticipez les questions de fond** :
  - *« Pourquoi pas des microservices ? »* → ADR-0001 : frontières émergentes + cohérence forte ingestion/audit ; extraction le long des coutures plus tard.
  - *« La sortie structurée ne suffit-elle pas ? »* → elle garantit la forme, pas la vérité ; le gate revérifie l'`evidence` contre l'OCR brut (frontière de confiance).
  - *« Double facturation des fournisseurs sur rejeu ? »* → non : artefact OCR/LLM immuable = garde exactly-once.
  - *« Conflit code-barres vs imprimé ? »* → GS1 gagne sur la valeur, mais le conflit critique force `needs_review`.
  - *« Et si le LLM hallucine mais que le GS1 corrige ? »* → ça reste bloquant : la réconciliation ne relâche jamais le verdict du gate.
- **Si on raccourcit à 10 min** : gardez 1, 2, 3, 5, 7, 8, 9, 12 (contraintes → style → intégrité base → outbox → gate → hybride → synthèse).
- **Ne lisez pas les encadrés 💡 à voix haute** : ils servent à répondre aux questions, précisément et sans hésiter.
