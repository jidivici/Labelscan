# LabelScan — Script de présentation (10 minutes)

> Archivé le 20 août 2026 : script antérieur au portail multi-métiers actuel.

**Public :** non-technique ou mixte (jury, direction, client).
**Durée :** 10 minutes · 9 diapos.
**Objet :** présenter l'application de bout en bout en expliquant tout le jargon.
**Format :** chaque diapo = ⏱️ durée · 🖥️ écran · 🗣️ texte à dire · 💡 jargon expliqué.
**Rythme :** ~140 mots/minute (le texte 🗣️ est calibré pour tenir dans le temps).

---

## Diapo 1 — Titre & accroche · ⏱️ 0:45 (cumul 0:45)

🖥️ *Logo « LabelScan » + une photo d'étiquette de poisson + slogan : « De la photo à la preuve. »*

🗣️
« Bonjour. Imaginez le rayon poissonnerie d'un grand magasin. Des centaines d'arrivages par semaine, chacun avec une étiquette : espèce, zone de pêche, numéro de lot, date limite. La loi impose de **tracer** tout ça — pouvoir prouver, des mois plus tard, d'où venait chaque poisson.

Aujourd'hui, c'est souvent fait à la main, sur un cahier ou un tableur. C'est lent, et ça se trompe. **LabelScan**, c'est une réponse à ce problème : on prend l'étiquette en photo, et le système en sort une fiche structurée, vérifiée, et impossible à falsifier. »

💡 **Traçabilité** = la capacité de retrouver l'historique et l'origine d'un produit à chaque étape.

---

## Diapo 2 — Le problème : HACCP & traçabilité · ⏱️ 1:15 (cumul 2:00)

🖥️ *Trois icônes : un poisson, une horloge (date limite), un thermomètre. Le mot « HACCP » en grand.*

🗣️
« Le cadre réglementaire s'appelle **HACCP**. Retenez juste l'idée : c'est la méthode officielle pour **maîtriser les risques sanitaires** dans l'alimentaire. Concrètement, elle impose de surveiller des points critiques — par exemple : la date limite est-elle dépassée ? La température de conservation est-elle respectée ? L'origine est-elle bien renseignée ?

Le défi technique, c'est que ces informations sont sur une étiquette en papier, dans un format différent à chaque fournisseur, parfois en plusieurs langues, parfois mal imprimées. Et l'enjeu est sérieux : si on se trompe sur une date limite, c'est un risque pour le consommateur. Donc la règle d'or du projet, c'est : **on préfère dire “je ne sais pas” plutôt que d'inventer une information**. On y reviendra — c'est le cœur du système. »

💡 **HACCP** (« Hazard Analysis Critical Control Points ») = méthode internationale d'analyse et de maîtrise des dangers alimentaires. Ici, l'app aide à respecter deux contrôles : dates et températures.
💡 **DLC** = Date Limite de Consommation (« à consommer jusqu'au »). **DDM** = Date de Durabilité Minimale (« à consommer de préférence avant »).

---

## Diapo 3 — Ce que fait LabelScan, en une phrase · ⏱️ 1:00 (cumul 3:00)

🖥️ *Capture d'écran de l'app : une photo d'étiquette à gauche, la fiche structurée à droite (espèce, lot, zone FAO, date…).*

🗣️
« Voilà le résultat concret. À gauche, la photo brute de l'étiquette. À droite, ce que le système en a extrait, **champ par champ** : la désignation commerciale, le nom scientifique de l'espèce, le numéro de lot, la zone de pêche, la date limite, la température, le poids…

L'opérateur prend la photo, **vérifie** en deux secondes, corrige si besoin, et valide. La saisie manuelle d'une dizaine de champs devient un geste de quelques secondes. Et surtout : chaque information est **rattachée à sa preuve** sur l'étiquette. »

💡 **Champ** = une case de la fiche (ex. « numéro de lot »). Le système en extrait **17**.
💡 **Zone FAO** = découpage mondial des zones de pêche par l'Organisation des Nations unies pour l'alimentation (ex. « 27 = Atlantique Nord-Est »).

---

## Diapo 4 — Le voyage d'une étiquette (le flux) · ⏱️ 2:00 (cumul 5:00)

🖥️ *Schéma horizontal en 6 étapes : 📷 Photo → ☁️ Envoi → 🗄️ Stockage brut → 👁️ OCR → 🤖 IA → ✅ Fiche vérifiée.*

🗣️
« Suivons une étiquette du début à la fin. Six étapes.

**Un** — la photo. L'application mobile cadre l'étiquette et la photographie.

**Deux** — l'envoi. La photo part vers le **serveur** par internet. L'app ne fait quasiment aucun calcul elle-même : c'est un **client léger**. Tout le travail intelligent est centralisé côté serveur — c'est plus sûr et plus facile à faire évoluer.

**Trois — et c'est une décision-clé** : avant tout traitement, on **archive la photo brute, telle quelle**. Pourquoi ? Parce que c'est la preuve originale. Quoi qu'il arrive ensuite, on pourra toujours revenir à l'image d'origine. Cette archive est **inviolable** : on peut y ajouter, jamais modifier ni supprimer.

**Quatre** — l'**OCR** : le serveur lit le texte présent sur l'image. C'est la technologie qui transforme une photo de texte en texte éditable — comme quand votre téléphone détecte un numéro dans une photo.

**Cinq** — l'**IA** : un modèle de langage analyse ce texte et le range dans les bonnes cases : ça, c'est l'espèce ; ça, c'est le lot ; ça, c'est la date.

**Six** — la fiche revient sur le mobile pour vérification, puis elle est enregistrée. Pendant que l'IA travaille — quelques secondes — l'opérateur voit déjà des résultats apparaître progressivement. Le tout sans jamais bloquer : il peut enchaîner l'étiquette suivante. »

💡 **Serveur / backend** = l'ordinateur central qui fait les calculs (la « cuisine »). **App / frontend** = ce que l'utilisateur voit (la « salle »).
💡 **Client léger** = une app qui se contente d'afficher et d'envoyer ; l'intelligence est ailleurs.
💡 **OCR** (« Optical Character Recognition ») = reconnaissance optique de caractères : photo de texte → texte numérique.
💡 **Traitement asynchrone** = le travail long se fait « en arrière-plan » (comme un ticket déposé en cuisine), sans faire attendre l'utilisateur.

---

## Diapo 5 — Idée forte n°1 : l'extraction hybride · ⏱️ 1:30 (cumul 6:30)

🖥️ *Deux colonnes qui fusionnent : « Code-barres GS1 → exact » + « OCR + IA → texte libre » → « Fiche réconciliée ».*

🗣️
« Première idée forte, et c'est ce qui rend LabelScan fiable. On combine **deux sources** d'information.

La première, c'est le **code-barres**. Pas le petit code à 13 chiffres du supermarché, mais le code-barres professionnel **GS1** — un standard mondial qui encode, de façon **mathématiquement exacte**, le numéro de lot, la date limite, le poids. Quand il est présent, ces valeurs sont **certaines** : aucune interprétation, on les lit directement.

La deuxième source, c'est l'**IA sur le texte** — pour tout ce que le code-barres ne contient pas : l'espèce, la zone de pêche, le mode de production…

Et voici l'astuce : ces deux sources se **réconcilient**. En cas de désaccord — par exemple le code-barres dit une date et le texte en dit une autre — **le code-barres l'emporte**, parce qu'il est exact ; et le désaccord est **signalé à un humain** parce que ça révèle un problème d'étiquetage. On utilise le bon outil pour chaque donnée : le calcul exact quand c'est possible, l'IA seulement là où elle est nécessaire. Ça améliore la fiabilité **et** ça réduit les coûts. »

💡 **Code-barres GS1** = standard mondial d'identification des produits ; il encode des champs précis (lot, date, poids) lisibles sans ambiguïté.
💡 **GTIN** = l'identifiant unique du produit contenu dans ce code-barres.
💡 **Déterministe** = qui donne toujours le même résultat exact (par opposition à une IA, qui « estime »).
💡 **Réconciliation** = fusionner deux sources en arbitrant les conflits selon des règles claires.

---

## Diapo 6 — Idée forte n°2 : « ne jamais inventer » · ⏱️ 1:15 (cumul 7:45)

🖥️ *Une valeur extraite avec une flèche qui pointe vers le bout de texte exact de l'étiquette qui la justifie. Tampon « VÉRIFIÉ ».*

🗣️
« Deuxième idée forte. Le grand risque d'une IA, c'est l'**hallucination** : produire une réponse plausible mais **fausse**. Dans l'alimentaire, c'est inacceptable.

LabelScan a donc un garde-fou, qu'on appelle le **gate anti-fabrication**. La règle est simple et stricte : **toute information produite par l'IA doit être justifiée par un morceau de texte présent, mot pour mot, sur l'étiquette.** Si l'IA propose une valeur qu'elle ne peut pas pointer du doigt dans le texte d'origine, cette valeur est **automatiquement supprimée** et le champ est marqué « à vérifier ». L'IA n'a pas le droit de deviner une espèce à partir d'un nom commun, ni de transformer un nom de mer en code de zone de pêche.

Conséquence : chaque donnée stockée porte sa **provenance** — elle sait exactement d'où elle vient — et un **indice de confiance**. Et tout ce qui est incertain part en **revue humaine**. Jamais d'acceptation silencieuse d'une donnée douteuse. »

💡 **Hallucination** = quand une IA invente une information fausse mais crédible.
💡 **Gate (anti-fabrication)** = un filtre automatique de contrôle ; ici, la « frontière de confiance » qui vérifie l'IA.
💡 **Provenance** = la trace de l'origine exacte d'une donnée (quelle image, quel passage du texte).
💡 **Revue humaine** (« human-in-the-loop ») = un humain valide les cas incertains avant qu'ils ne soient acceptés.

---

## Diapo 7 — Idée forte n°3 : une mémoire inviolable · ⏱️ 1:00 (cumul 8:45)

🖥️ *Icône d'un registre où l'on écrit au stylo — pas de gomme. Mention « append-only » + « journal d'audit ».*

🗣️
« Troisième idée forte, essentielle pour une preuve réglementaire : la **mémoire est inviolable**.

Les données de traçabilité sont stockées en mode **“append-only”** : on peut **ajouter**, jamais **modifier** ni **effacer**. Comme un registre rempli au stylo : pas de gomme. Une correction ne réécrit pas l'ancienne valeur — elle crée une **nouvelle version** à côté, et l'ancienne reste consultable.

Et chaque écriture déclenche, **dans la base de données elle-même**, un **journal d'audit** : qui a fait quoi, quand. Le point fort, c'est que cette protection est posée au niveau le plus bas — la base — donc **même un administrateur ne peut pas la contourner**. Pour un système de conformité, c'est exactement ce qu'il faut : on peut prouver l'historique, et personne ne peut le falsifier après coup. »

💡 **Append-only** (« ajout seul ») = on n'ajoute que des lignes ; modifier ou supprimer est techniquement interdit.
💡 **Immuable** = qui ne peut pas être changé une fois écrit.
💡 **Journal d'audit** = registre automatique de toutes les actions (qui, quoi, quand).
💡 **Base de données** = le grand classeur électronique où tout est rangé et interrogeable (ici, PostgreSQL).

---

## Diapo 8 — L'architecture, en une image · ⏱️ 0:45 (cumul 9:30)

🖥️ *Schéma : 6 blocs « contextes » (Ingestion, HACCP, Traçabilité, Conformité, Audit, Identité) reliés par des flèches « événements ». Légende : « prises standardisées ».*

🗣️
« Un mot sur la solidité de l'ensemble. Le système est découpé en **modules métier étanches** : l'ingestion des étiquettes, les contrôles HACCP, la traçabilité, l'audit… Chacun a une seule responsabilité et communique avec les autres par **messages**, jamais en se mélangeant.

Surtout, les briques sensibles — l'OCR, l'IA — sont branchées comme des **prises électriques standardisées** : on peut changer de fournisseur d'IA ou d'OCR **sans toucher au reste**, comme on change d'appareil sans refaire l'installation électrique. C'est ce qui rend le système **durable et évolutif** : il n'est prisonnier d'aucun fournisseur. »

💡 **Monolithe modulaire** = une seule application, mais découpée en modules bien séparés (simple à déployer, propre à l'intérieur).
💡 **Architecture hexagonale / ports & adapters** = les « prises standardisées » : le cœur du métier ne dépend pas des outils externes, qui sont interchangeables.
💡 **Contexte (DDD)** = un domaine métier autonome avec son propre vocabulaire (ingestion, HACCP…).
💡 **API** = le « passe-plat » normalisé par lequel l'app et le serveur se parlent.

---

## Diapo 9 — Conclusion & chiffres · ⏱️ 0:30 (cumul 10:00)

🖥️ *Quelques chiffres + une phrase de clôture.*

🗣️
« Pour résumer : LabelScan transforme une **photo d'étiquette** en **donnée de traçabilité fiable, justifiée et infalsifiable** — en quelques secondes.

Trois principes : **on combine** code-barres exact et IA ; **on n'invente jamais** ; **on garde une mémoire inviolable**. Derrière, c'est une application mobile, un serveur Python, une base de données robuste, des centaines de tests automatisés, et une architecture pensée pour durer.

Le bon outil, pour un vrai enjeu de sécurité alimentaire. Merci — je réponds à vos questions. »

💡 **Repères chiffrés à citer** : ~8 600 lignes (mobile) + ~6 400 lignes (serveur) · **17 champs** extraits · **11** versions de base de données · **6** modules métier · des **centaines de tests** automatisés.

---

## 📕 Lexique express (carte de secours pour les questions)

| Terme | En une phrase |
|---|---|
| **HACCP** | Méthode officielle de maîtrise des risques alimentaires (dates, températures, origine). |
| **Traçabilité** | Retrouver l'origine et l'historique de chaque produit. |
| **DLC / DDM** | Date limite de consommation / date de durabilité minimale. |
| **Zone FAO** | Zone mondiale de pêche définie par l'ONU (ex. 27 = Atlantique NE). |
| **Backend / Frontend** | Le serveur (cuisine) / l'app visible (salle). |
| **Client léger** | App qui affiche et envoie ; l'intelligence est sur le serveur. |
| **API** | Le « passe-plat » normalisé entre app et serveur. |
| **OCR** | Lecture du texte présent sur une image. |
| **LLM / IA générative** | Modèle qui lit et comprend du texte (ici, Claude Haiku). |
| **GS1 / GTIN** | Code-barres professionnel encodant lot/date/poids de façon exacte. |
| **Déterministe** | Résultat exact et reproductible (vs « estimation »). |
| **Réconciliation** | Fusion de deux sources en arbitrant les conflits. |
| **Hallucination** | Quand l'IA invente une info fausse mais crédible. |
| **Gate anti-fabrication** | Filtre qui supprime toute valeur non justifiée par l'étiquette. |
| **Provenance** | Trace de l'origine exacte d'une donnée. |
| **Indice de confiance** | Note de fiabilité attachée à chaque champ. |
| **Revue humaine** | Validation humaine des cas incertains. |
| **Asynchrone / worker** | Traitement long fait en arrière-plan sans bloquer l'utilisateur. |
| **Append-only / immuable** | On ajoute, jamais on n'efface ni ne modifie. |
| **Journal d'audit** | Registre automatique : qui a fait quoi, quand. |
| **Base de données / PostgreSQL** | Le classeur électronique central, interrogeable. |
| **Monolithe modulaire** | Une seule app, découpée en modules étanches. |
| **Hexagonal / ports & adapters** | Briques externes interchangeables comme des prises standardisées. |
| **JWT** | Le « badge » numérique qui authentifie chaque appareil. |

---

## 🎯 Conseils de présentation

- **Pic émotionnel = Diapo 6** (« ne jamais inventer »). C'est l'argument qui marque : appuyez dessus, ralentissez.
- **Si on vous coupe le temps** : gardez Diapos 1, 4, 6, 9 (problème → flux → garde-fou IA → conclusion). Récit complet en 4 minutes.
- **Question piège probable** : « Et si l'IA se trompe ? » → gate anti-fabrication + revue humaine + le code-barres exact qui arbitre.
- **Évitez** de lire les encadrés 💡 à voix haute : ils sont là pour vous (et pour les questions), pas pour le discours.
