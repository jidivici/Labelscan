# Validation employé — maquette HTML initiale

Le parcours est désormais intégré à l’application mobile sur cette branche. Pour le rendu web du **même composant React Native**, utiliser [l’aperçu mobile partagé](../../preview/mobile-hygiene/README.md). Le fichier HTML de ce dossier est conservé comme première maquette, sans synchronisation automatique avec le mobile.

Ouvrir `index.html` dans un navigateur. Cette page autonome permet d'essayer les parcours d'hygiène LabelScan ; elle n'est pas raccordée à l'application, à l'authentification ou au serveur. Aucun appel réseau, stockage persistant ou contrôle sanitaire réel. Les saisies disparaissent au rechargement. Utiliser des données fictives. Le visa nominatif est simulé.

## Parcours

Choisir un contrôle, renseigner la journée et l'heure réelle, suivre les étapes conditionnelles, documenter les anomalies puis relire et viser. Aucun résultat de contrôle n'est présélectionné. Modifier une réponse antérieure invalide les réponses suivantes et le visa. Une donnée manquante ou une impossibilité ne vaut pas conformité. Les anomalies restent visibles après le visa, même après un recontrôle.

| Parcours | Pages du PDF Hygiène fourni | Données principales |
| --- | --- | --- |
| Fraîcheur / Anisakis / taille | 3–4 | Lot, fournisseur, réception, grille applicable, aspect, parasites, mesure et référence de taille |
| Réception | 1–2 | Livraison, colis échantillonnés, sonde, température entre UVC, trois relevés à cœur si nécessaire, denrées, décision |
| Températures | 5–6 | Équipement, créneau, enregistrement automatique et alarme, sonde, mesure, protocole, verdict |
| Vivier | 9–10 | Vivier, état, lecture densimètre, température, anomalie, action, nouvelle mesure ou échéance |
| Nettoyage | 7–8 | Zone, élément, fréquence, protocole, produit, dose, température, temps de contact, réalisation |
| Cuisson / refroidissement | 11–12 | Produit, provenance, quantité, lot, DLC, barème, équipements, dates/heures, températures de sortie |
| Sonde | 2, 6, 12 | Sonde, bain glacé, lecture, retrait et remplacement si seuil atteint |

Source : Hygiène.pdf fourni par l'utilisateur, PMS Produits de la mer, juin 2017. Les numéros ci-dessus sont les pages du PDF, pas la pagination imprimée du cahier. Le document source n'est pas recopié dans le dépôt.

## Règles représentées

- Vivier : lecture cible 1022, plage inclusive 1020–1025 ; pas de conversion en g/L. Environ 13 °C est une indication du cahier, sans plage de conformité inventée. Un vivier vide mais en service conserve ses mesures ; hors service exige un motif. Une mesure initiale reste visible avec le recontrôle.
- Réception : un colis de centrale par camion au milieu de palette ; tous les colis en direct, cas du camion entier orienté vers les produits sensibles. Trois températures à cœur après résultat entre UVC non conforme ; moyenne déclarée non conforme impose le refus.
- Relevés : matin/après-midi ; hebdomadaire seulement avec enregistrement automatique et alarme.
- Sonde : remplacement aux seuils inclusifs −0,9 et +0,9 °C.
- Refroidissement : cible 4 °C, tolérance 10 °C, en moins de 120 minutes depuis la sortie cuisson. Les dates complètes couvrent minuit. Un délai d'entrée en cellule déclenche un constat. Le PDF prescrit l'élimination si la température finale dépasse 10 °C.
- Fraîcheur, tailles et cuisson : le PDF renvoie à des grilles/barèmes externes. Pas de score, taille universelle ou température de cuisson inventés. Les ambiguïtés des tolérances de réception et du signe de correction de sonde ne sont pas automatisées.

Les identifiants d'équipement, motifs d'impossibilité, responsables, échéances et invalidations de réponses sont des choix de conception pour la traçabilité, distincts des champs imprimés. Ce prototype reproduit les schémas du document historique ; il ne certifie pas un référentiel réglementaire actuel.

## Tester

```sh
node --test prototypes/validation-hygiene-employes/workflow.test.cjs
```

17 tests : seuils, cas vivier, impossibilités, effacement des réponses devenues invalides, refus réception, références manquantes, refroidissement à minuit, dates et accès au visa pour les sept parcours. Les tests chargent le script de la page elle-même.

Vérification navigateur effectuée : vivier vide en service → lecture 1028 → action → recontrôle 1022 → visa simulé ; affichage mobile 390 px sans débordement horizontal, rendu bureau 1100 px et aucune erreur JavaScript.

## Intégration ultérieure

La maquette initiale était isolée. L’écran natif est maintenant intégré en mode test ; après validation du parcours restent notamment la sélection du lot existant, identité authentifiée, règles versionnées validées par le magasin, brouillons, API d'enregistrement, droits, historique et suivi des écarts restent à réaliser. Ce prototype ne crée ni fiche ni signature dans LabelScan.
