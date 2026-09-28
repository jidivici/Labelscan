# Extraction V3 : préserver l’ingestion lorsqu’un champ est incertain

## Version examinée

Production vérifiée le 28 septembre 2026 : `e66f8b77082fed64ef80fa1f20597f4ba6b7d6bb`.
Le profil poissonnerie V3 contient 14 champs, sans DLC/DDM ni GTIN. Le retrait est
bien déployé, mais le rejet global d’une réponse IA pour une valeur métier invalide
et l’interdiction de `&` dans la zone FAO sont encore présents dans cette version.

La correction est préparée sur `extraction-field-review`, à partir de cette
révision. Elle ne modifie pas les captures ni les arrivages de production.

## Décision

Un prompt peut réduire les erreurs, pas garantir leur absence. La continuité du
traitement est donc assurée par le serveur : les défauts de champs deviennent des
éléments à vérifier, pas des motifs d’abandon du scan.

| Situation | Comportement corrigé |
|---|---|
| Zone `FAO 27 IV & autres ss zones` | Texte conservé exactement, accepté côté serveur et mobile |
| Date incomplète, poids invalide, confiance incorrecte, preuve mal formée | Champ laissé vide et marqué invalide avec un avertissement ; autres champs conservés |
| Normalisation typographique sûre, comme `1,25 KG` | `1.25 kg`, statut normalisé et preuve originale conservée |
| Deux propositions pour le même champ | Champ laissé à vérifier, aucune sélection arbitraire |
| Champ historique DLC ou GTIN renvoyé dans une réponse V3 | Exclu du profil V3 |
| Preuve absente du texte OCR | Valeur annulée par le contrôle de provenance existant ; revue obligatoire |
| Réponse IA entièrement inexploitable après les tentatives limitées | Fiche en revue manuelle, photo et OCR conservés, propositions déterministes fiables conservées |
| Toutes les propositions sont invalides | Revue manuelle possible, pas d’obligation injustifiée de reprendre la photo |
| OCR réellement inexploitable | Le parcours photo illisible reste distinct |
| Panne réseau, accès fournisseur refusé, configuration invalide | Erreur technique distincte ; cette correction ne la fait pas passer pour une extraction réussie |

Une valeur rejetée n’est jamais publiée comme donnée confirmée. Les contrôles de
longueur, de caractères de contrôle, de format et de provenance restent actifs.
La revue finale reste explicite et contrôlée côté serveur. La conservation de
propositions partielles ne vaut pas validation de leurs informations.

## Prompt V3 autonome

Le prompt V3 est écrit directement, sans suppressions successives dans un ancien
prompt contenant encore les consignes DLC et GTIN. Son identité est
`food-label-extraction/poissonnerie/profile-3/prompt-v3.0.0`.

- Audit complet des 14 champs ; sortie limitée aux champs étayés ou ambigus.
- Preuves copiées exactement depuis l’OCR ; aucune connaissance externe utilisée
  pour remplir une valeur manquante.
- Une ambiguïté ne concerne que son champ ; les autres informations continuent
  d’être extraites.
- Consignes explicites pour distinguer référence produit, lot, date de
  conditionnement, date d’expédition et dates non demandées.
- Exemples centrés sur le cas FURIC et sur une date incomplète qui ne bloque pas
  l’extraction de l’espèce et de la méthode de production.

Le texte passe de **22 610 à 8 583 caractères**, soit **62 % de moins**. Il s’agit
d’une mesure de taille, pas d’une mesure de coût ou de latence. L’éligibilité au
cache continue d’être contrôlée par le comptage de jetons du fournisseur ; un
préfixe sous son seuil n’est pas déclaré cacheable. Les prompts historiques V1/V2
restent disponibles pour les anciens scans.

## FAO : un texte fidèle, pas un référentiel géographique implicite

La zone reste une seule désignation textuelle. Les niveaux imprimés sont
conservés : `27`, `27.7`, `IV`, `VIII`, `27.8.b.1`, avec les qualificatifs tels que
`& autres ss zones`. La ponctuation usuelle est acceptée dans les deux validateurs.

Ne pas convertir les chiffres romains, développer les abréviations, déduire une
sous-zone, transformer un océan en numéro ou déduire un pays de la zone. Une zone
explicitement désignée peut rester textuelle sans ajout de code. Une liste de
zones imprimée comme une seule désignation reste une liste ; des blocs
contradictoires deviennent une ambiguïté à vérifier.

Cette logique garantit la fidélité et la provenance de la proposition. Elle ne
prétend pas certifier la justesse géographique de ce que le fournisseur a imprimé.

## Revue et diagnostic

Les anomalies de champs sont isolées avant stockage. Même un champ facultatif
invalide ou ambigu force la revue, y compris une date sans valeur exploitable.
Le résultat reste exploitable par le suivi mobile existant.

Les logs de validation contiennent uniquement le nom de champ du contrat et une
raison contrôlée (`invalid_value`, `invalid_evidence`, `duplicate_field`, etc.),
sans recopier la valeur de l’étiquette. Le repli après une réponse entière
inexploitable est identifié par `llm_output_manual_review` et par une version
d’extracteur interne explicite, distincte d’une réponse IA réussie.

## Validation et livraison

Tests de régression sans appels externes : cas FURIC, ponctuation FAO, champs
malformés, dates invalides, GTIN retiré, doublons, preuve inventée, réponses JSON
invalides et confirmation manuelle après repli. Le parcours est testé sur une
base PostgreSQL locale avec le véritable worker, les écritures, l’API de lecture
et la finalisation, en simulant les fournisseurs.

Résultats : **620 tests serveur réussis**, deux tests nécessitant des appels
fournisseur ignorés ; **61 tests mobiles réussis**. Typage TypeScript, lint Python,
cinq contrats d’architecture et contrôle du diff réussis.

La qualité statistique du nouveau prompt sur un corpus réel et ses coûts de
cache n’ont pas été mesurés par des appels IA dans cette modification. Les tests
garantissent le comportement applicatif face aux erreurs simulées, pas l’absence
d’erreurs de génération futures.

Livraison proposée : déployer serveur et workers ensemble, puis le mobile avec
son validateur FAO aligné. Aucune migration de base ni changement du contrat HTTP
n’est requis. Les anciens scans restent dans leur profil d’origine ; la nouvelle
validation peut également isoler un GTIN invalide lors d’un rejeu historique V2.
Le déploiement et la relance des scans existants sont des opérations distinctes
de cette préparation, non effectuées ici.
