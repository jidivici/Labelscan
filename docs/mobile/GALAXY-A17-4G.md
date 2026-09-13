# Galaxy A17 4G : photos, essais Android et mode kiosque

Guide établi le 13 septembre 2026 à partir du code LabelScan, des deux captures
fournies et de documentations officielles. Les scénarios ci-dessous constituent une
matrice de validation à exécuter sur le téléphone ; ils ne sont pas des résultats
de tests matériels ni une liste exhaustive de tous les défauts possibles.

Validation locale actuelle : TypeScript, 51 suites / 423 tests et contrat
Android 13 réussis ; bundle Expo Android actualisé avec la reprise de connexion
au démarrage et les icônes de barre d'état sombres sur les écrans clairs. Le cadrage
a été validé par l'utilisateur dans Expo Go. Le build n° 6 a été compilé par EAS ;
son archive, son manifeste et la présence de la reprise réseau dans le bundle ont
été vérifiés. Le bundle diffère de celui du build 4. Le rendu des icônes et le
redémarrage kiosque restent à vérifier sur le téléphone.

## Ce qui est établi

- La première capture montre l'aperçu caméra, un cadre placé trop haut et la
  navigation Android à trois boutons. Voir l'aperçu ne prouve pas que la prise de
  photo native fonctionne.
- La seconde affiche **« Cannot connect to Expo CLI »**. Ce message vient de la
  connexion de développement Expo/Metro, comme le confirme
  `node_modules/expo/src/async-require/hmrUtils.native.ts`. Elle ne contient pas le
  détail natif de l'erreur de capture signalée par l'utilisateur.
- Le code caméra désactivait son callback de codes-barres pendant la prise de vue.
  Dans la version Expo Camera installée, changer cette activation provoque une
  reconfiguration Android et un `unbindAll()` : cela peut interrompre la prise de
  photo en cours. C'est une cause concrète identifiée dans le code ; son implication
  exacte sur cet exemplaire A17 reste à confirmer après installation du correctif.
- Android exige de traiter séparément la disponibilité de la caméra, les doubles
  appuis, le passage en arrière-plan et le retour depuis les permissions. Expo
  demande d'attendre `onCameraReady` avant une photo ; une capture pendant un aperçu
  en pause échoue sur Android. [Documentation Expo Camera](https://docs.expo.dev/versions/latest/sdk/camera/)
- Les anciennes photos sont des ressources protégées de l'API, pas des images de
  la Galerie Samsung. Leur lecture exige une session autorisée et un réseau
  utilisable si aucune copie locale n'est déjà conservée. Donner une permission Galerie ne
  répare pas une expiration de session ou une erreur réseau. `app.json` n'accorde
  volontairement ni microphone ni anciennes permissions de stockage partagé.

Le déplacement et le dimensionnement du cadre doivent être propres à Android :
partir de la surface réellement mesurée de la caméra, respecter les barres système,
puis utiliser la même géométrie pour le recadrage enregistré. Déplacer uniquement
les coins dessinés créerait un décalage entre ce que l'opérateur vise et l'image
envoyée. Le rendu iOS doit conserver ses valeurs actuelles.

### Complément après les captures 27.jpg et 29.jpg

La visionneuse Android est maintenant une fenêtre opaque couvrant aussi les barres
système. L'image entière est centrée sur les dimensions mesurées de cette fenêtre,
pour que l'écran précédent ne reste pas visible en haut. Le rendu iOS est conservé.

Le guide Android est centré sur les deux axes de l'aperçu mesuré. Comme CameraX
tourne les photos avec le téléphone même quand l'interface reste verticale, cette
symétrie évite de déplacer la découpe selon le sens de rotation. Les tests couvrent
les deux sens et démontrent le décalage de l'ancien cadre asymétrique. Les captures
fournies ne prouvent pas que ce défaut explique à lui seul toute la perte observée :
la correspondance du champ de vue natif et un mouvement après visée restent à
vérifier sur l'A17.

### Essai : agrandir le cadre vers le flash

Le haut du cadre est remonté pour laisser **12 points sous les boutons du haut**.
Le bord inférieur et les côtés restent en place. La surface caméra est raccourcie
par le bas, derrière le déclencheur, afin que ce cadre agrandi reste centré dans
l'aperçu réel : la découpe utilise cette nouvelle surface, et non la hauteur de
l'écran complet. Une bande noire peut donc apparaître sous les commandes du bas.
Sur une scène de 360 × 728 avec des marges système de 24, le haut passe de 132 à
88, le bas reste à 596, et la hauteur du cadre passe de 464 à 508.
L'aperçu caméra mesure alors 360 × 684. Le build EAS n° 2 du 13 septembre a été
annulé avant cet ajustement. L'utilisateur a ensuite confirmé avoir testé et validé
ce cadrage sur son téléphone ; le build n° 3 reprend cette version. Cette validation
du cadrage ne vaut pas exécution de toute la matrice de recette ci-dessous.
Les prises déjà enregistrées ne sont pas modifiées.

Après rechargement du code, reprendre une photo avec quatre repères à l'intérieur
des coins du cadre et vérifier leur présence en plein écran. Une ancienne image
déjà découpée ne peut pas retrouver les pixels qui ont été retirés. Les journaux
`capture_geometry` contiennent maintenant les dimensions de l'aperçu et du cadre
en plus des dimensions source, de la découpe et du résultat.

### Reprise réseau au démarrage

Le build n° 4 ajoute une reprise automatique lorsque le réseau ou le serveur tarde
à répondre au lancement. La session conservée dans SecureStore n'est plus supprimée
pour une panne réseau temporaire : l'application affiche **« Connexion au serveur… »**
et réessaie après 2, 5, 10, puis 30 secondes entre les tentatives. L'accès aux articles
et le traitement des captures ne commencent qu'après validation de la session par
le serveur. Une déconnexion annule les tentatives et leurs réponses tardives.

Une session refusée, expirée ou révoquée demande toujours une nouvelle connexion.
Le code serveur prévoit une durée de renouvellement de 7 jours par défaut,
configurable jusqu'à 30 jours ; la valeur active en production n'a pas été vérifiée.
Chaque renouvellement réussi prolonge cette durée. Une réponse perdue après la
consommation d'un jeton à usage unique peut aussi imposer de se reconnecter.
Le code kiosque administrateur, le verrouillage Android et la connexion LabelScan
sont trois mécanismes distincts.

### Lisibilité de l'heure et de la batterie

Le build 6 ajoute des icônes de barre d'état sombres sur les écrans clairs
Android : connexion, attente réseau, articles, fiche et révision. La configuration
native et la navigation déclarent ce style explicitement, car la navigation
réappliquait sinon son défaut blanc. Sur le fond noir de la caméra et de la
visionneuse photo, les icônes restent blanches. La page d'autorisation caméra,
qui est claire, utilise des icônes sombres.

Sur Android 13/14, la caméra conserve sa barre translucide lorsqu'elle est au
premier plan, afin de préserver la surface mesurée. Sur Android 15 et suivants,
la navigation pilote la couleur des icônes dans le mode bord à bord imposé par
Android. Le build 5 intermédiaire a été annulé avant cet ajustement de compatibilité.

Le cadrage, l'aperçu et la découpe ne sont pas redimensionnés par cette correction.
À vérifier sur l'A17 : démarrage, ouverture/fermeture caméra, puis ouverture/fermeture
d'une photo ; les icônes doivent retrouver leur style sombre en revenant aux articles.

## Identifier le téléphone et l'environnement

Relever **Paramètres > À propos du téléphone** puis **Informations sur le logiciel** :
référence exacte, Android, One UI, correctif de sécurité et numéro de version.
Relever aussi RAM, espace libre, version d'Expo Go ou identifiant du build LabelScan.

Une fiche Samsung officielle de l'A17 LTE **SM-A175F** indique 4 Go/128 Go, écran
6,7 pouces 1080 × 2340, trois capteurs arrière 50 + 5 + 2 MP, stabilisation optique,
réseau 4G et batterie 5 000 mAh. Les configurations et disponibilités varient selon
le marché. Ces caractéristiques ne permettent pas de déduire la mémoire ni le
firmware de l'appareil testé ; l'A17 5G est une autre référence.
[Fiche Samsung A17 LTE](https://www.samsung.com/ru/smartphones/galaxy-a/galaxy-a17-light-blue-128gb-sm-a175flbncau/)

Samsung propose des manuels A17 pour Android 15 et Android 16 : ne pas déduire la
version installée du seul nom commercial. Les libellés One UI peuvent évoluer.
[Assistance Samsung SM-A175F](https://www.samsung.com/at/support/model/SM-A175FZAEEUE/)

## Retester avec une application autonome

Le profil `preview` de [eas.json](../../eas.json) produit déjà un APK installable,
avec l'API `https://label-scan.fr`. Le package Android est
`com.anonymous.LabelScan` et la version minimale Android est 13/API 33.
Le numéro de build Android est désormais incrémenté automatiquement à chaque
build `preview`, pour identifier les nouvelles installations et leurs mises à jour.

Depuis la racine du dépôt, avec un compte Expo autorisé pour ce projet :

```sh
npx eas-cli@latest build --platform android --profile preview
```

À la fin du build, ouvrir sur l'A17 le lien APK fourni par EAS, installer puis
ouvrir **LabelScan**. Ce profil embarque le JavaScript : le Mac et Metro ne sont
plus nécessaires pour lancer l'application. L'API reste nécessaire pour la
connexion, l'extraction et les photos non présentes localement.
[Distribution APK Expo](https://docs.expo.dev/build-reference/apk/)

**APK actuel créé le 13 septembre 2026 : LabelScan 1.0.0, build 6.**

- [Télécharger LabelScan 1.0.0 — build 6](https://expo.dev/artifacts/eas/7gcxw7uVfWT4LkPOz566JhU6fyo_4fNsuzkzj5HUixA.apk)
- [Compilation EAS terminée](https://expo.dev/accounts/shutteru90/projects/LabelScan/builds/025189f1-df57-499b-bc23-a46ab974db25)
- Copie locale : `output/android/LabelScan-1.0.0-build-6.apk`.
- SHA-256 : `0b138a1324997697fd431882b9d3828d5af2e0c48520b2ca9c1fd379cd43f3e5`.
- Manifeste inspecté : package `com.anonymous.LabelScan`, versionCode `6`,
  Android minimum 13/API 33, cible API 36, HTTP clair et sauvegarde désactivés,
  permission caméra et JavaScript embarqué présents. L'attribut `debuggable`
  est absent (valeur Android par défaut : faux). Cette inspection n'est pas une
  vérification cryptographique indépendante de la signature.

Ce build remplace le build 4 et reprend la même clé de signature EAS. Il contient
le cadrage validé, la reprise de session après panne réseau au lancement et les
icônes sombres sur les écrans clairs. Les icônes restent blanches sur la caméra
et les photos. Le build 5 intermédiaire a été annulé.
QR de téléchargement : `output/android/LabelScan-build-6-installation-qr.png`.

**Installation sur le Samsung :**

1. Dans **Expo Go** ou l'ancien LabelScan, terminer la synchronisation des captures
   en attente et vérifier leur présence sur le serveur. Les données locales d'Expo
   Go ne sont pas transférées automatiquement à l'APK.
2. Ouvrir le lien EAS sur le téléphone, télécharger l'APK puis toucher le fichier.
   Si demandé, rechercher **Installation applis inconnues** dans les Paramètres et
   autoriser uniquement la source utilisée, par exemple **Chrome** ou **Mes fichiers**.
   [Autoriser une source sur Samsung](https://www.samsung.com/us/support/troubleshoot/TSG10001913/)
3. Si **Bloqueur automatique** empêche l'installation, ouvrir **Paramètres > Sécurité
   et confidentialité > Bloqueur automatique** et le désactiver temporairement pour
   cet APK, puis relancer l'installation. Les libellés varient selon One UI.
4. Toucher **Installer** ou **Mettre à jour**, ouvrir **LabelScan**, se connecter,
   autoriser la caméra et tester une photo.
5. Réactiver le Bloqueur automatique s'il était actif, puis retirer l'autorisation
   d'installation accordée à Chrome/Mes fichiers.
   [Blocage et désactivation temporaire documentés par Samsung](https://www.samsung.com/fr/support/mobile-devices/proteger-votre-appareil-mobile-samsung-galaxy-avec-le-bloqueur-automatique-de-samsung/)

Un ancien APK LabelScan et le nouveau `preview` partagent le package
`com.anonymous.LabelScan`. La clé créée pour cette première compilation EAS peut
différer de celle de l'ancien APK : une mise à jour directe exige une signature
compatible. Si Android signale une incompatibilité de signature, désinstaller
l'ancien **LabelScan** seulement après avoir vérifié la synchronisation, puis
installer le nouvel APK. **La désinstallation efface ses données locales.** Expo Go
est une application distincte et n'a pas besoin d'être désinstallée.
[Conditions des mises à jour Android](https://developer.android.com/google/play/app-updates)

Pour poursuivre le diagnostic dans Expo Go, laisser Metro ouvert et garder le Mac
et le téléphone sur un réseau qui permet leur communication. Un Wi-Fi invité, un
VPN, le pare-feu ou le passage du téléphone en 4G peut couper cette liaison. Le
mode `npx expo start --go --tunnel` peut aider pour **Metro** ; il ne publie pas une API
locale et ne rend pas `localhost` accessible depuis le téléphone.
[Connexion et tunnel Expo CLI](https://docs.expo.dev/more/expo-cli/#tunneling)

Pour recharger le code corrigé dans Expo Go avec l'API publique du projet :

```sh
EXPO_PUBLIC_API_BASE_URL=https://label-scan.fr npx expo start --go --clear
```

Scanner le nouveau QR code et laisser ce terminal ouvert pendant les essais.

## Matrice de validation A17

Utiliser des étiquettes de test. Pour chaque essai, noter le build, l'heure, l'état
du réseau, le résultat visible, le nombre de captures effectivement enregistrées
et, en cas d'échec, le message complet. Les résultats attendus ci-dessous sont les
critères d'acceptation ; une ligne non testée reste **à vérifier**.

| Situation à reproduire | Critère à vérifier |
| --- | --- |
| Ouvrir la caméra à froid puis toucher immédiatement le déclencheur | Aucun appel avant que la caméra soit prête ; capture possible ensuite. |
| Accorder l'appareil photo pendant l'utilisation ; refaire après « Cette fois seulement » | Autorisation bien relue ; nouveau dialogue si nécessaire ; pas d'aperçu bloqué. |
| Refuser puis refuser durablement ; autoriser ensuite depuis les réglages | Explication utilisable, accès aux réglages, reprise au retour. |
| Désactiver l'accès global à la caméra, puis le réactiver | État compréhensible et récupération ; ne pas confondre avec la permission de l'application. |
| Une capture sans code-barres puis une avec code-barres visible | La reconnaissance ne redémarre pas la caméra pendant la photo. |
| Double appui très rapide ; puis 10 photos successives | Une seule capture native simultanée ; aucune photo perdue ou créée par un appui ignoré. |
| Détecter deux codes successifs puis déclencher | Le code joint correspond au dernier contexte prévu ; pas d'ancien code réutilisé indéfiniment. |
| Lampe éteinte, allumée, puis tentative de changement pendant la capture | Photo valide ; pas de reconfiguration concurrente ; retour à un état cohérent. |
| Retour Android, Accueil, verrouillage, appel entrant ou ouverture des notifications | Caméra libérée en arrière-plan ; capture de nouveau possible au retour. |
| Quitter juste après le déclenchement ou pendant le recadrage | La photo durable déjà acceptée reste retrouvable ; aucune erreur silencieuse. |
| Tenir droit, tourner à gauche/droite, tourner pendant la capture | Orientation et zone enregistrées cohérentes avec l'instant du déclenchement. |
| Navigation à trois boutons puis gestes ; taille d'affichage et police augmentées | Coins et boutons accessibles ; cadre légèrement abaissé sur Android ; pas de chevauchement. |
| Étiquette avec quatre repères placés près des coins du cadre | Les mêmes repères sont présents dans la photo recadrée, y compris après changement de navigation. |
| Lumière faible, reflets, mouvement, étiquette trop proche | Comparer netteté et lecture ; une photo floue est différente d'une erreur de capture. |
| 30 captures en série, puis ouverture rapide de plusieurs photos existantes | Mémoire maîtrisée, absence de fermeture, nombre final conforme aux prises acceptées. |
| Espace de stockage déjà faible, sur appareil de test | Échec explicite si la copie durable est impossible ; aucun succès affiché sans photo conservée. |
| Wi-Fi stable puis 4G seule | Capture locale possible dans la session ouverte ; upload et anciennes photos passent par l'API HTTPS. |
| Couper le réseau avant la prise, pendant l'envoi puis pendant une lecture photo | État d'attente/erreur clair ; reprise au retour du réseau ; pas de faux doublon à la réémission. |
| Wi-Fi connecté sans Internet, portail captif, 4G faible | Ne pas assimiler « connecté au Wi-Fi » à une API joignable ; sortie possible d'une attente réseau. |
| Basculer Wi-Fi ↔ 4G durant un envoi ; économie de données active | Reprise bornée et identifiant de requête conservé ; pas d'attente infinie. |
| Ouvrir une ancienne photo jamais vue, puis la rouvrir hors connexion | Premier accès demande le réseau ; second accès dépend de la copie locale réellement présente. |
| Session expirée lors du chargement photo | Renouvellement contrôlé ou retour à la connexion ; aucune image vide sans explication. |
| Photo absente côté serveur, refus d'accès, erreur serveur | Distinguer absence, droits et panne ; pouvoir réessayer les erreurs temporaires. |
| Changer de compte/magasin pendant une lecture ; revenir au compte initial | Aucune photo d'une autre session affichée ; cache et demandes en cours correctement isolés. |
| Économie d'énergie, veille prolongée puis retour dans l'app | Caméra relancée et file reprise au premier plan ; aucune promesse d'envoi continu téléphone endormi. |
| Téléphone chaud ou en charge lors d'une série normale | Mesurer ralentissement et erreurs sans provoquer volontairement une surchauffe. |
| Fermeture du processus puis relance ; redémarrage avec file en attente | Reprise des données durables et comportement de reconnexion explicite. |
| Mise à jour de LabelScan puis mise à jour Android/One UI | Refaire capture, permissions, recadrage, anciennes photos et kiosque. |
| Même parcours caméra sur iPhone | Géométrie iOS identique et aucun changement de cadrage introduit par l'adaptation Android. |

Les variantes de permission temporaire et de révocation sont documentées par
[Android](https://developer.android.com/training/permissions/requesting#one-time).
Un interrupteur de confidentialité global peut aussi produire un flux caméra vide
sur un appareil compatible, même si l'application a sa permission.
[Accès global caméra Android](https://developer.android.com/training/permissions/explaining-access#toggles)

La navigation par gestes, les trois boutons et les découpes d'écran influencent
les marges disponibles. Android 15 impose notamment l'affichage bord à bord aux
applications qui ciblent API 35 : un calcul fondé uniquement sur les dimensions
de l'écran peut devenir incorrect.
[Marges système Android 15](https://developer.android.com/about/versions/15/behavior-changes-15#window-insets)

Samsung peut mettre des applications en veille ou en veille profonde. Pour un
téléphone de travail, contrôler **Paramètres > Batterie > Limites d'utilisation en
arrière-plan** — parfois sous **Maintenance de l'appareil > Batterie** — et la
liste des applications jamais en veille. Cela ne transforme pas la file JavaScript
LabelScan en service Android permanent ; la reprise au premier plan reste à tester.
[Gestion de la batterie Samsung](https://www.samsung.com/us/support/answer/ANS10002534/)

## Mode kiosque simple : épingler LabelScan

Pour les essais et un usage surveillé, l'épinglage intégré évite de sortir
accidentellement de l'application. Commencer avec l'APK **LabelScan** : épingler
Expo Go ne donne pas une installation métier autonome.

1. Définir un code de verrouillage du téléphone connu de l'administrateur.
2. Ouvrir **Paramètres > Sécurité et confidentialité > Autres paramètres de
   sécurité > Épinglage de l'application**. Selon One UI, l'option peut s'appeler
   **Épingler l'application** ou **Autoriser l'épinglage des applications**.
   Si elle n'apparaît pas, rechercher « épingl » dans les Paramètres.
3. Activer l'épinglage et l'option demandant le code ou la méthode de
   déverrouillage avant le désépinglage.
4. Ouvrir LabelScan, se connecter et accorder l'appareil photo.
5. Ouvrir **Récents** (bouton `|||` sur la capture), toucher l'**icône LabelScan
   au-dessus de sa carte**, puis **Épingler cette application**.

Cette procédure suit les libellés publiés par
[Samsung France](https://news.samsung.com/fr/the-knox-journals-1) ; leur position
exacte doit être confirmée sur la version One UI installée.

Pour sortir avec les trois boutons : maintenir **Retour + Récents**, puis saisir
le code. Avec les gestes : balayer vers le haut et maintenir, puis déverrouiller.
[Désépinglage Android](https://support.google.com/android/answer/9455138?hl=fr)

L'épinglage n'administre pas le téléphone et ne configure pas le lancement
automatique après un redémarrage. Il ne bloque pas les fonctions internes de
LabelScan, par exemple sa déconnexion. Le mode kiosque administré ci-dessous est
nécessaire pour contrôler durablement un appareil dédié.
[Épinglage et lock task Android](https://developer.android.com/work/dpc/dedicated-devices/lock-task-mode)

## Sans entreprise : essayer Fully Single App Kiosk

Pour cet A17, commencer par un essai **sans réinitialisation**. Fully propose une
licence individuelle **8,90 € + taxes**, payable une fois. L'essai gratuit affiche
un grand filigrane **« Please get a license »** ; la licence PLUS le retire. Après
validation des essais, l'achat se fait depuis **Get a PLUS License** dans Fully.
[Licence Fully PLUS](https://license.fully-kiosk.com/license/single)

1. Ouvrir l'APK LabelScan à jour, se connecter et autoriser la caméra.
2. Installer **Fully Single App Kiosk** depuis les
   [téléchargements officiels](https://www.fully-kiosk.com/en/#download).
   Sélectionner **LabelScan** (`com.anonymous.LabelScan`) comme application unique.
3. Définir le **Kiosk PIN** réservé à l'administrateur. Accorder les permissions
   demandées pour le kiosque et choisir Fully comme application d'accueil par
   défaut. Activer **Launch on Boot** et **Wait for Boot Completed**.
4. Mettre le verrouillage de l'écran Android sur **Aucun / None**. Garder
   **Lock Safe Mode désactivé**, car il impose un PIN Android. Le PIN de sortie
   Fully est séparé : **sept touches très rapides**, puis saisie du PIN.
   [Réglages, démarrage et limites Fully](https://www.fully-kiosk.com/en/)
5. Si une SIM est utilisée, désactiver son verrouillage PIN dans **Paramètres >
   Sécurité et confidentialité > Autres paramètres de sécurité > Définir
   verrouillage SIM**, avec le PIN actuel.
   [Réglage SIM Samsung](https://www.samsung.com/fr/support/mobile-devices/deverrouiller-mon-smartphone-apres-avoir-insere-une-nouvelle-carte-sim/)

Pour le premier essai, activer **Enable Test Mode** : Fully revient automatiquement
après 60 secondes. Vérifier aussi la sortie avec le PIN, puis désactiver ce mode
test avant la recette de redémarrage.
[Mode test et sortie Fully Single App](https://play.google.com/store/apps/details?id=com.fullykiosk.singleapp)

**À vérifier sur le téléphone :** redémarrer sans toucher l'écran, attendre le
retour dans LabelScan, puis tester une photo et la sortie administrateur. Refaire
avec réseau retardé. Ne pas acheter avant ces essais. Android 15/16 peut limiter
le verrouillage standard ou la relance d'une application arrêtée par le système.

Pour un verrouillage renforcé, utiliser **Fully Kiosk Browser en Single App Mode**
comme **Device Owner**, puis **Lock Task Mode**, **Disable Status Bar** et
**Disable Keyguard**. Il lance toujours l'application native LabelScan. Éviter les
**KNOX Settings** de Fully, réservés aux professionnels. Le
[configurateur QR public](https://cloud.fully-kiosk.com/cloud/expressProvisioning)
demande un appareil neuf ou réinitialisé : préparer la configuration, synchroniser
les captures et sauvegarder les données avant tout effacement. Aucun reset ni
achat n'a été effectué ici.

## Alternative avec une entreprise : démarrage autonome avec Knox Manage

Objectif : après un redémarrage normal, le Samsung revient dans LabelScan sans
demander un code Android. Le code de sortie du kiosque reste réservé à
l'administrateur. La connexion initiale à LabelScan se fait une fois pendant la
préparation ; une session révoquée ou expirée peut encore demander de se reconnecter.
Cette configuration reste à réaliser et à tester sur l'A17 ; aucun téléphone n'a
été réinitialisé ou enrôlé depuis ce dépôt.

### 1. Préparer le compte depuis le Mac

**Choix de l'offre : Knox Suite Base ne suffit pas pour cette procédure**, car il
ne comprend pas Knox Manage. **Knox Suite Essentials suffit** pour administrer ce
kiosque LabelScan ; Enterprise n'est pas nécessaire pour cet usage. On peut
commencer avec l'essai Enterprise de trois mois, puis obtenir une licence
Essentials et remplacer la licence d'essai dans le même compte.
[Services inclus dans chaque offre Knox](https://docs.samsungknox.com/admin/fundamentals/knox-licenses/)

1. Ouvrir [l'inscription Samsung Knox](https://www.samsungknox.com/en/register),
   choisir **I want to try Samsung Knox services**, puis **Knox Suite - Enterprise
   Plan**. L'essai annoncé est de **90 jours** et comprend Knox Manage. Créer le
   compte **Samsung account for Business**, vérifier l'adresse professionnelle et
   renseigner l'entreprise. Samsung peut demander son numéro D-U-N-S, ou à défaut
   son numéro de TVA ou d'immatriculation, puis valider l'inscription par email.
   [Création du compte](https://docs.samsungknox.com/admin/fundamentals/register-for-samsung-knox/create-a-samsung-knox-account/)
2. Après validation, ouvrir le **Knox Admin Portal**, puis **Knox Manage**.
   Dans **Licenses**, vérifier que l'essai est actif. Si nécessaire : **ACTIONS >
   Get a license > Knox Suite - Enterprise Plan > GENERATE TRIAL LICENSE**.
   Pour conserver le service après l'essai, demander la licence adaptée via
   **FIND RESELLER** ; aucun abonnement n'est acheté par cette procédure.
   [Licences et essai](https://docs.samsungknox.com/admin/knox-admin-portal/how-to-guides/manage-knox-licenses/)
3. Dans le tableau de bord Knox Manage, **Get started > LINK ACCOUNT** : associer
   le compte Google qui administrera Android Enterprise et terminer l'assistant.
   Créer ensuite **Users > CREATE USER**, par exemple `labelscan-a17`, avec son
   mot de passe d'enrôlement et une adresse email accessible depuis le Mac. Créer
   le groupe **LabelScan** et y ajouter cet utilisateur. Le mot de passe
   d'enrôlement est demandé à l'installation, pas à chaque redémarrage.
   [Assistant initial Knox Manage](https://docs.samsungknox.com/admin/knox-manage/new-console/get-started/get-started-tutorial/)

### 2. Préparer LabelScan et son profil dans la nouvelle console

4. Télécharger sur le Mac le dernier APK indiqué dans **Retester avec une
   application autonome** ci-dessus. Dans Knox Manage : **Library > Apps >
   IN-HOUSE APPS > ADD IN-HOUSE APP**, choisir cet APK, nommer l'application
   **LabelScan**, puis **ADD**. Le package attendu est `com.anonymous.LabelScan`.
   [Importer un APK interne](https://docs.samsungknox.com/admin/knox-manage/new-console/manage-apps/add-apps/)
5. Sélectionner LabelScan, puis **ACTIONS > Assign app(s)**. Choisir
   **Auto-installed (reinstalled if removed by the user)** et **Automatically run
   app > After installation and every app update**. Affecter au groupe
   **LabelScan**, puis **ASSIGN**. Ce réglage concerne installation et mise à jour ;
   le profil kiosque assure le fonctionnement dédié du téléphone.
   [Affecter une application](https://docs.samsungknox.com/admin/knox-manage/new-console/manage-apps/assign-apps/)
6. Créer **Profiles and policies > CREATE PROFILE**, nom **LabelScan kiosque**,
   puis **NEXT: CONFIGURE**. Dans **Kiosk settings**, choisir **Single-app mode >
   SELECT APP > IN-HOUSE APPS > LabelScan > CONFIRM**. Dans **Utility settings**,
   **décocher Keyguard**, **Home button**, **Recent apps** et **Notification bar**.
   Laisser **Hide info icon décoché** pour conserver la sortie locale. Ne pas
   exposer **Lockscreen** dans les réglages accessibles aux opérateurs.
   [Réglages du kiosque](https://docs.samsungknox.com/admin/knox-manage/new-console/configure-kiosks/build-a-single-app-kiosk/)
7. Dans le profil, laisser la caméra autorisée et ne configurer aucune obligation
   de PIN, schéma ou mot de passe Android. Garder l'accès Wi-Fi/4G nécessaire à
   `https://label-scan.fr`. Terminer par **CREATE AND ASSIGN**, choisir le groupe
   **LabelScan**, puis **ASSIGN AND PUSH PROFILE**.
   [Créer et affecter un profil](https://docs.samsungknox.com/admin/knox-manage/new-console/manage-profiles-and-policies/create-a-profile-and-policies/)

### 3. Enrôler le Samsung et vérifier le redémarrage

8. Depuis **Users**, sélectionner `labelscan-a17`, puis **ACTIONS > Send enrollment
   guide**. Choisir **Fully managed**, envoyer le guide et afficher son QR code
   sur le Mac. **Avant d'effacer le téléphone**, terminer la synchronisation des
   captures et vérifier leur présence sur le serveur ; sauvegarder les autres
   données à conserver et garder les accès Google/Samsung disponibles.
9. Une fois ces vérifications terminées, sur le téléphone : **Paramètres > Gestion
   globale > Réinitialisation > Réinitialisation données usine**. Lire la liste des
   éléments effacés puis confirmer. **Cette étape efface les données locales.**
   [Réinitialiser un Samsung](https://www.samsung.com/fr/support/mobile-devices/comment-reinitialiser-mon-smartphone-tablette-ou-restaurer-les-parametres-d-usine/)
10. À l'écran **Bienvenue / Welcome**, toucher **six fois au même endroit** sans
    appuyer sur Démarrer. Scanner le QR reçu par email, connecter le Wi-Fi et
    terminer l'enrôlement avec le mot de passe `labelscan-a17`. Vérifier dans la
    console que le type de gestion est **Fully managed**. Laisser Knox installer
    LabelScan, s'y connecter et autoriser la caméra. Ne créer aucun code de
    verrouillage Android pendant cette préparation.
    [Enrôlement complet par QR](https://docs.samsungknox.com/admin/knox-manage/new-console/manage-devices/enroll-a-device/)
11. Relever le code réservé à l'administrateur dans **Devices > A17 > SECURITY >
    KIOSK > Exit kiosk code**. Tester la sortie sur le téléphone avec **ⓘ > Exit
    Kiosk > code > OK**, puis appliquer une mise à jour du profil pour réactiver
    le kiosque. Ce code est distinct du verrouillage Android.
    [Sortir puis réactiver le kiosque](https://docs.samsungknox.com/admin/knox-manage/new-console/configure-kiosks/exit-kiosk-mode/)

Si un code Android existe encore, le retirer avant la recette, ou utiliser sur
le téléphone connecté **Devices > A17 > ACTIONS > Perform action on device >
Clear screen lock**, après avoir retiré toute politique qui impose ce code.
[Effacer le verrouillage dans la nouvelle console](https://docs.samsungknox.com/admin/knox-manage/new-console/manage-devices/send-device-commands/)

Si la SIM demande un PIN, désactiver **Paramètres > Sécurité et confidentialité >
Autres paramètres de sécurité > Définir verrouillage SIM > Verrouillage de la
carte SIM**, en saisissant son PIN actuel. Cela permet la reprise mobile sans
intervention. Le chemin exact peut varier avec One UI.
[Verrouillage SIM Samsung](https://www.samsung.com/fr/support/mobile-devices/deverrouiller-mon-smartphone-apres-avoir-insere-une-nouvelle-carte-sim/)

**Recette finale :** redémarrer le téléphone sans le toucher. Il doit revenir dans
LabelScan sans code Android, SIM ou Knox, puis permettre une photo après retour du
réseau. Refaire l'essai avec le Wi-Fi indisponible au démarrage, puis rétabli.
Vérifier aussi que les boutons Accueil/Récents ne permettent pas de sortir et que
la sortie administrateur fonctionne. Les intitulés ci-dessus sont ceux de la
nouvelle console ; le résultat après démarrage reste à confirmer sur le firmware
réel de l'A17. L'essai de panne réseau doit utiliser l'APK qui contient le
correctif de conservation de session, pas une ancienne installation.

## Kiosque durable : Android Enterprise et Knox Manage

Pour un poste dédié en magasin, utiliser un administrateur de terminaux (MDM/EMM),
par exemple Knox Manage. Il faut un compte d'administration, la licence applicable,
un APK signé et un appareil enrôlé **Android Enterprise Fully Managed**. Un simple
profil professionnel ou un bouton ajouté dans LabelScan ne suffit pas. La nouvelle
console Knox Manage documente le kiosque mono-application sur **Android Enterprise
12 ou ultérieur en gestion complète** ; vérifier aussi la compatibilité de la
référence exacte dans l'offre choisie.
[Prérequis kiosque Knox Manage, nouvelle console](https://docs.samsungknox.com/admin/knox-manage/new-console/configure-kiosks/kiosk-types-and-minimum-requirements/)

Procédure d'administration à préparer :

1. Enregistrer l'APK signé LabelScan comme application interne, ou préparer sa
   distribution privée Managed Google Play. Conserver le package
   `com.anonymous.LabelScan` et la clé de signature pour les mises à jour.
2. Préparer l'enrôlement complet par QR code ou Knox Mobile Enrollment selon le
   parc. Le parcours d'enrôlement initial demande normalement un appareil neuf ou
   réinitialisé. **Une réinitialisation efface les données locales** : synchroniser
   les captures en attente, sauvegarder les données nécessaires et organiser cette
   opération séparément. Aucune réinitialisation n'a été effectuée ici.
   Pour la méthode QR : à l'écran de bienvenue de l'appareil neuf ou réinitialisé,
   toucher **six fois au même endroit**, puis scanner le QR d'enrôlement généré
   par la console de gestion et suivre ses étapes.
   [Enrôlement Android par QR code](https://developers.google.com/android/management/provision-device#qr_code_method)
3. Dans la nouvelle console Knox Manage : **Profiles and policies > profil >
   Configure > Kiosk settings > Single-app mode > SELECT APP**, choisir LabelScan
   dans les applications internes, puis affecter le profil au téléphone/groupe.
   Les menus de l'ancienne console diffèrent.
   [Kiosque mono-application Knox](https://docs.samsungknox.com/admin/knox-manage/new-console/configure-kiosks/build-a-single-app-kiosk/)
4. Configurer la permission caméra, l'accès HTTPS à l'API, le Wi-Fi/les données
   mobiles, le lancement au démarrage et la sortie administrateur. Définir une
   fenêtre de mise à jour et vérifier la reprise après crash/redémarrage. Ne pas
   désactiver le capteur caméra dans la politique : LabelScan utilise le capteur
   directement et n'a pas besoin d'ouvrir l'application Galerie.
5. Vérifier le parcours complet en kiosque, notamment connexion, clavier, appareil
   photo, consultation et export. Un partage vers une autre application nécessite
   une politique qui l'autorise ; si cet usage est requis, prévoir un kiosque avec
   les applications nécessaires au lieu d'un verrouillage strict sur une seule.

### Sortie administrateur dans la nouvelle console Knox Manage

Préparer et tester la sortie avant de confier le téléphone à un opérateur.

- **Depuis le téléphone, même hors réseau** : conserver l'icône d'information
  **ⓘ** visible, donc laisser **Hide info icon** désactivé. Dans la console,
  ouvrir **Devices > téléphone > SECURITY > KIOSK** et relever le **Exit kiosk
  code** réservé à l'administrateur. Sur le téléphone : **ⓘ > Exit Kiosk > code >
  OK**. Si l'icône est masquée, cette sortie locale n'est pas disponible.
- **À distance, téléphone connecté** : **Devices > sélectionner le téléphone >
  ACTIONS > Perform action on device > USER AND PROFILE > Exit Kiosk mode >
  Confirm**.

Ces sorties conservent les politiques du profil. Pour revenir au kiosque,
appliquer une mise à jour du profil au téléphone. Pour quitter durablement le
kiosque, retirer l'affectation du profil kiosque au groupe et affecter un profil
adapté, ou affecter un autre profil de priorité supérieure.
[Sortie et réactivation du kiosque Knox Manage](https://docs.samsungknox.com/admin/knox-manage/new-console/configure-kiosks/exit-kiosk-mode/)

Le mécanisme Android sous-jacent est **lock task mode**, avec des applications
autorisées par le contrôleur de politique. Le démarrage automatique, les boutons
système, la sortie d'administration et le maintien de l'écran allumé sont des
réglages distincts à valider. La présence de Knox sur le Samsung ne signifie pas
que cette gestion est déjà configurée.
[Contrôle du kiosque Android](https://developer.android.com/work/dpc/dedicated-devices/lock-task-mode),
[appareils dédiés et démarrage](https://developer.android.com/work/dpc/dedicated-devices/cookbook)

## Première recette à effectuer sur l'A17

1. Installer l'APK corrigé et noter Android/One UI ainsi que le build.
2. Tester dix prises avec et sans code-barres, un double appui et un verrouillage/
   déverrouillage ; comparer le cadre affiché à la photo enregistrée.
3. Ouvrir une photo d'arrivage existant en Wi-Fi puis en 4G, et vérifier la reprise
   après coupure réseau.
4. Épingler LabelScan et refaire capture/consultation ; vérifier la sortie par code.
5. Consigner les résultats. Si une capture échoue encore, recueillir le **message
   complet de capture** et son heure : la seule alerte de connexion Expo ne permet
   pas d'attribuer la panne au capteur Samsung.
