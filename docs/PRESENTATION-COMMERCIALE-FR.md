# LabelScan — texte d’accompagnement commercial

Version du 6 septembre 2026

Présentation Canva : `DAHUETchgBg`

Durée indicative : 8 à 10 minutes

## Positionnement à retenir

> LabelScan transforme une photo d’étiquette fournisseur en une donnée de traçabilité
> structurée, sourcée et validée par le métier. L’IA propose, les règles contrôlent,
> l’humain décide.

Cette formulation décrit ce qui existe dans le dépôt. Elle ne promet ni exactitude absolue,
ni conformité automatique, ni gain de temps non mesuré.

## Texte à dire, diapositive par diapositive

### 1 — Ouverture

« Une étiquette papier contient déjà une grande partie de l’information utile. Le problème
commence quand elle est pliée, déchirée, rangée dans un cahier ou difficile à retrouver au
moment où chaque minute compte. LabelScan relie cette preuve terrain à une donnée structurée,
vérifiable et recherchable, sans retirer à l’opérateur sa responsabilité de validation. »

Preuve produit : [README, parcours et principe de confiance](/Users/__fdbrv/Labelscan/README.md:3).

### 2 — Le récit

« La démonstration suit quatre temps : le risque opérationnel du papier, la chaîne LabelScan,
les preuves techniques et métier, puis un pilote mesuré. L’objectif n’est pas de demander une
décision sur une promesse théorique, mais d’obtenir une réponse chiffrée sur un périmètre réel. »

### 3 — L’alerte sanitaire

« Un lot est signalé. Il faut répondre à trois questions simples : est-il entré, quand a-t-il
été reçu et de quel fournisseur vient-il ? Dans les contrôles menés par la DGCCRF en 2022 et
2023, 20 à 25 % des contrôles présentaient un problème de traçabilité. Ce chiffre décrit le
contexte sectoriel ; ce n’est pas une performance LabelScan. »

Source externe : [DGCCRF, 23 décembre 2024](https://www.economie.gouv.fr/dgccrf/laction-de-la-dgccrf/les-enquetes-et-les-controles/produits-de-laquaculture-et-de-la-peche-trop-de-flou-dans-linformation-des-consommateurs).

### 4 — Le papier, une preuve fragile (pages Canva 4 à 8)

« Les photos montrent une situation concrète : l’information existe, mais son support peut
être déchiré, froissé ou incomplet. Elles prouvent l’existence du problème observé, pas sa
fréquence dans tout le marché. Le sujet n’est donc pas de supprimer la preuve d’origine ; il
est de la conserver et de rendre son contenu exploitable. »

Les trois premières photos fournies sont suffisantes. L’illustration du scanner et la capture
d’écran mobile peuvent rester hors de cette séquence.

### 5 — La chaîne LabelScan

« L’opérateur photographie l’étiquette entière. Lorsqu’un code reconnu est présent,
l’application fournit le contexte GS1. Le serveur conserve l’image, lance l’OCR et
l’extraction structurée, puis réconcilie les propositions avec des règles déterministes.
Enfin, l’opérateur vérifie et confirme la version qui rejoint le catalogue autorisé du
magasin. »

Sources : [README, étapes 1 à 5](/Users/__fdbrv/Labelscan/README.md:13) ;
[architecture du pipeline, soumission durable](/Users/__fdbrv/Labelscan/docs/pipeline/PIPELINE-ARCHITECTURE.md:64).

### 6 — La démonstration en quatre gestes

« Premier geste : photographier l’étiquette. Deuxième geste : contrôler les champs proposés
et les incertitudes visibles. Troisième geste : compléter si nécessaire et valider. Quatrième
geste : retrouver le lot par son numéro, même sans connaître sa date d’arrivée. La valeur du
produit tient autant à la recherche qu’à la capture. »

À montrer : une capture réelle, une fiche en revue, une correction, puis une recherche de lot.
Ne pas annoncer de temps gagné avant une mesure avant/après.

### 7 — Trois niveaux de valeur et trois métiers

« Pour le personnel, le bénéfice attendu est une capture guidée et moins de ressaisie. Pour le
directeur, c’est une recherche ciblée avec la photo et l’historique. Pour l’enseigne, c’est un
socle multisite avec des accès cloisonnés. Ce même socle couvre aujourd’hui trois profils :
Poissonnerie, Boucherie et Charcuterie/Traiteur. »

« Les profils actifs comportent 16 champs en poissonnerie et 21 dans chacun des deux autres
métiers. Ces chiffres décrivent le produit ; ils ne constituent pas une checklist juridique
officiellement validée. »

Sources : [profils métiers](/Users/__fdbrv/Labelscan/docs/mobile/MOBILE-APP.md:40) ;
[nombre de champs et limite réglementaire](/Users/__fdbrv/Labelscan/docs/ai-pipeline/AI-PIPELINE.md:42).

### 8 — Une IA vérifiable, pas une IA infaillible

« LabelScan ne transforme pas une réponse de modèle en vérité métier. Chaque valeur proposée
par le modèle doit être reliée à un extrait exact du texte OCR. Sans preuve, la valeur devient
nulle et part en revue. Les valeurs GS1 suivent un chemin déterministe et gardent la priorité
sur les champs qu’elles encodent. En cas de conflit critique, le système demande une revue. »

« Cette approche rend la proposition explicable. Elle ne prouve pas à elle seule que
l’interprétation est sémantiquement correcte : l’humain reste la frontière de publication,
et chaque correction crée une nouvelle version. »

Sources : [evidence gate et limites](/Users/__fdbrv/Labelscan/docs/ai-pipeline/AI-PIPELINE.md:229) ;
[priorité GS1](/Users/__fdbrv/Labelscan/docs/ai-pipeline/AI-PIPELINE.md:269) ;
[contrat de revue humaine](/Users/__fdbrv/Labelscan/docs/extraction/PROMPT-CONTRACT.md:174).

### 9 — Des objectifs de pilote, pas des résultats annoncés

« Les trois nombres affichés sont des seuils de départ proposés : au moins 80 % de champs
préremplis, moins de 60 secondes pour retrouver un lot et 100 % des corrections historisées.
Ils ne doivent pas être présentés comme des résultats actuels. Le pilote sert précisément à
les confirmer, les ajuster ou les rejeter sur des arrivages réels. »

Le dépôt ne contient encore aucune mesure représentative de précision, de rappel, de taux de
correction, de latence fournisseur ou de coût réel :
[limites de l’évaluation](/Users/__fdbrv/Labelscan/docs/pipeline/eval-suite.md:44).

### 10 — Le cadre 2026

« Depuis le 10 janvier 2026, les opérateurs aval de la filière pêche doivent transmettre
électroniquement les informations minimales de traçabilité. En France, dans l’attente de
normes plus détaillées, un e-mail ou un PDF suffit à ce jour. LabelScan n’est donc pas une
obligation réglementaire ; c’est un moyen de faciliter la collecte, le contrôle, l’archivage
et la recherche des informations. »

« La conformité finale reste celle du processus de l’opérateur. Les profils LabelScan sont
des règles applicatives et ne doivent pas être présentés comme une garantie juridique. »

Sources : [ministère chargé de la mer, mise à jour du 20 mars 2026](https://www.mer.gouv.fr/tracabilite-des-produits-de-la-peche-et-de-la-mer) ;
[limite du contrat applicatif](/Users/__fdbrv/Labelscan/docs/extraction/PROMPT-CONTRACT.md:105).

### 11 — Une démarche d’industrialisation transparente

« LabelScan possède un parcours de livraison structuré : contrôles TypeScript et tests des
clients, tests et migrations du serveur, audits de dépendances, construction et scan des
images, sauvegarde avant déploiement et vérifications après mise en ligne. Le projet documente
également ses risques ouverts au lieu de les masquer. »

« C’est la formulation juste : un socle industrialisable et une instance publique en service,
pas une certification générale “production-ready”. Des risques de lancement restent ouverts
et doivent être traités ou formellement acceptés. »

Sources : [workflow de livraison Hostinger](/Users/__fdbrv/Labelscan/deploy/README.md:159) ;
[registre des risques ouverts](/Users/__fdbrv/Labelscan/docs/security/THREAT-MODEL.md:37).

Le 6 septembre 2026, les points publics de liveness, readiness et le back-office répondaient
en HTTP 200. Cette observation ponctuelle ne mesure ni disponibilité historique ni SLO.

### 12 — Décision et pilote

« La proposition est volontairement simple : quatre semaines dans deux magasins, sur des
arrivages réels, avec une mesure avant/après. Nous suivons le temps de traitement, la qualité
des champs, le besoin de correction et le temps de recherche d’un lot. À l’issue du pilote,
la décision de déploiement repose sur des gains mesurés et des risques recensés. »

« LabelScan ne demande pas de croire à une promesse. Il propose de produire la preuve de sa
valeur sur le terrain. »

## Différenciation vérifiable

La revendication « solution unique sur le marché » n’est pas défendable. Hublot, EtiQali,
Pescader-IA, eEAT et d’autres solutions publient déjà des fonctions proches de photographie,
d’OCR et de traçabilité. Le positionnement sûr est :

> Une approche intégrée et différenciante réunissant capture mobile, lecture GS1, OCR,
> extraction structurée, preuve par champ, validation humaine, historique versionné et
> adaptation multi-métier.

La combinaison est documentée dans LabelScan ; l’absence d’un équivalent chez tous les
concurrents ne l’est pas.

Sources marché : [Hublot](https://www.hublot.io/notre-solution/),
[France Filière Pêche — projet APRI](https://www.francefilierepeche.fr/projets/apri/),
[EtiQali](https://www.etiqali.com/fr/),
[Pescader-IA](https://pescaderia.app/),
[eEAT](https://eeat-haccp.io/outils/tracabilite).

## Statut du pentest

Le dépôt prouve une préparation pré-pentest, mais pas le démarrage d’un audit externe. Tant
qu’une preuve de mission n’est pas fournie, ne pas inscrire « pentest en cours » dans le deck.

Formulation utilisable après confirmation documentaire :

> Un pentest indépendant est en cours sur **[périmètre]**, depuis **[mois année]**, avec un
> rapport attendu en **[mois année]**.

Source interne actuelle :
[checklist de préparation](/Users/__fdbrv/Labelscan/docs/security/PRE-PENTEST-CHECKLIST.md:1).

## Métriques à fournir avant d’ajouter des résultats commerciaux

Pour chaque chiffre, préciser la période, la taille d’échantillon, le métier, la méthode de
calcul et la source. Les données prioritaires sont :

1. mois de début et de fin du pilote ;
2. nombre de magasins, utilisateurs actifs et arrivages réels ;
3. nombre d’étiquettes et de fournisseurs/formats couverts ;
4. temps médian et P90 avant/après par étiquette ;
5. latence médiane et P95 entre photo et fiche prête à revoir ;
6. précision et rappel par champ critique sur une vérité terrain annotée ;
7. taux de champs acceptés, corrigés, marqués `NC` ou nécessitant une nouvelle photo ;
8. taux d’échec et de reprise après coupure réseau ;
9. temps médian de recherche d’un lot avant/après ;
10. coût OCR + LLM par arrivée et par mois ;
11. disponibilité mesurée sur une période définie ;
12. pour le pentest : prestataire, périmètre, date de début, phase actuelle, mois du rapport
    et date de retest.

## Guide d’animation sobre à appliquer dans Canva

Les animations ne sont pas modifiables par le connecteur Canva utilisé pour cette révision.
Réglage manuel recommandé : deux effets maximum dans tout le deck, durées de 0,25 à 0,45 s,
sans rebond, rotation, panoramique ni zoom de page.

| Moment | Ordre recommandé | Effet |
|---|---|---|
| Couverture | logo, titre, promesse, signature | Fondu puis légère montée ; 0,30 s par groupe |
| Sommaire | les quatre temps, de gauche à droite | Fondu décalé de 0,10 s |
| Alerte | heure et situation, puis les trois questions | Fondu ; questions révélées une à une |
| Papier, pages 4 à 8 | vue d’ensemble, puis focus sur chaque photo | Dissolution courte entre pages ; supprimer tout zoom plein écran |
| Chaîne LabelScan | Capturer, Structurer, Valider | Apparition séquentielle ; ligne fixe |
| Démonstration | cartes 01, 02, 03, puis barre 04 | Légère montée de 0,30 s ; aucun mouvement global |
| Valeur | Personnel, Directeur, Enseigne | Fondu séquentiel de 0,25 s |
| IA vérifiable | centre, quatre preuves, phrase finale | Fondu ; satellites par paires |
| Objectifs pilote | trois seuils, puis avertissement | Fondu séquentiel ; avertissement en dernier |
| Cadre 2026 | photo, puis trois obligations | Fondu ; blocs 01–03 un à un |
| Pilote | S1 à S4, puis les trois cartes de mesure | Fondu horizontal discret |
| Décision | titre, proposition de pilote, critères | Fondu simple ; CTA en dernier |

Si les pages 5 à 7 servent uniquement à simuler un gros zoom sur les photos, la version la
plus sobre consiste à conserver la vue d’ensemble de la page 4 et à révéler les trois images
dans cette même page. Sinon, garder les pages mais remplacer leur mouvement par une simple
dissolution de 0,20 à 0,25 s.

## Formulations à éviter

- « solution unique sur le marché » ;
- « zéro erreur » ou « IA fiable à 100 % » ;
- « conforme HACCP » ou « conformité garantie » ;
- « production-ready » ou « sécurité validée » ;
- « pentest en cours » sans mission datée ;
- tout gain, précision, ROI, coût ou disponibilité sans période et échantillon.
