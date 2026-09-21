# Aperçu web du parcours mobile Hygiène

Cet aperçu monte `src/features/hygiene/HygieneWorkflow.tsx` avec React Native Web. C'est le même composant que l'écran mobile `HygieneWorkflowScreen`, et non la maquette HTML initiale.

## Accès mobile

Sur cette branche de test, ouvrir les fiches du portail Poissonnerie puis **Hygiène · Test du parcours employé**. La journée sélectionnée est transmise au formulaire et le nom de l'employé vient de sa session. Le parcours reste en mémoire, sans appel au serveur, écriture dans le catalogue ou signature réelle.

## Accès web local

Depuis la racine du dépôt :

```sh
npm ci --prefix preview/mobile-hygiene
npm run dev --prefix preview/mobile-hygiene -- --port 5177
```

Ouvrir http://127.0.0.1:5177/. L'aperçu utilise un opérateur fictif et ne charge ni l'authentification, ni le catalogue, ni les API de production. Il montre l'écran mobile directement ; il ne remplace pas le back-office web.

```sh
node --test preview/mobile-hygiene/workflow.test.mjs
npm run typecheck
npm run build --prefix preview/mobile-hygiene
```

17 tests couvrent le moteur partagé, les seuils du PDF, les branches conditionnelles, les dates, les références manquantes et l'invalidation des réponses suivantes. Le composant a aussi été vérifié dans Chromium à 390 px et 1100 px : vivier vide en service, lecture 1028, action, recontrôle 1022, visa simulé, retour à une mesure impossible avec motif et suppression des anciennes actions. Export Expo Android réussi ; pas de test sur appareil physique.

## Source et limites

Le moteur reprend les schémas du PDF Hygiène fourni, PMS Produits de la mer de juin 2017. Voir la [correspondance des pages et champs](../../prototypes/validation-hygiene-employes/README.md). Les références externes de fraîcheur, tailles et cuisson restent à fournir par le magasin ; aucune règle manquante n'est inventée. Les dates sont saisies au format indiqué à l'écran. Les brouillons disparaissent à la fermeture de l'écran mobile ou au rechargement web.

Le composant et son moteur sont partagés entre plateformes. L'intégration serveur, la persistance, les droits de validation, la signature et la résolution des incidents restent hors de ce test.
