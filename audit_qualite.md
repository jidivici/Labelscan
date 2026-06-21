# MISSION D'AUDIT STRICT : Vérification de l'augmentation réelle de la qualité
**Rôle :** Lead QA Engineer & UX/UI Auditor (Intransigeant)
**Modèle d'exécution :** Claude Opus 4.8

## 🎯 Objectif
Avant de valider l'intégration finale de la refonte, tu dois auditer de manière critique le code généré, l'architecture et l'interface. L'objectif n'est pas d'écrire de nouvelles features, mais de **prouver** que l'expérience utilisateur (vitesse perçue, clarté) et la qualité du code ont drastiquement augmenté.

## 🔬 Matrice de vérification (Checklist à valider point par point)

**1. Audit de la Vitesse Perçue (Cascade Loading)**
- Analyse le code du module `SaveArticleView`.
- L'UI est-elle bloquée en attendant Haiku ? (Si oui, c'est un échec).
- Les données GS1 s'affichent-elles de manière garantie à T+0s ?
- Le passage du *Skeleton Loading* aux données finales de Haiku provoque-t-il un saut visuel désagréable (Layout Shift) ? Corrige si nécessaire.

**2. Audit du "No-Nonsense" et de la Sobriété UI**
- Scanne tout le code frontend (Détails et Enregistrement).
- **Tolérance Zéro :** Recherche et supprime la moindre trace de variables, commentaires ou composants liés à : `confidence_score`, `isModified`, `needsReview`, `pourcentage`, ou des badges dynamiques d'IA.
- Vérifie que tout le wording est en français parfait, concis, sans phrases explicatives inutiles.
- La photo a-t-elle bien un ratio et un `object-fit: cover` qui garantissent qu'elle ne déformera jamais la mise en page, quelle que soit la résolution de l'image envoyée ?

**3. Audit de la Fiabilité Fonctionnelle**
- Vérifie l'algorithme de la `HomePage`. Gère-t-il correctement les jours vides ? Le tri alphabétique par nom de poisson respecte-t-il les majuscules/minuscules de manière uniforme ?
- Le Store/Hook de l'Omni-Search est-il optimisé ? Ne va-t-il pas faire crasher le frontend si la base de données contient 5000+ lots ? (Vérifie la présence de debounce sur l'input).

**4. Audit du Prompt Haiku et Sécurité**
- Le prompt généré pour Haiku est-il assez robuste face à une étiquette de poisson partiellement effacée ou mal orthographiée ?
- Fais une dernière passe de sécurité : y a-t-il le moindre risque de fuite de clé API dans les appels client-side ?

## 📦 Livrables attendus de ta part (Opus)
1. **Un rapport de faille (Audit Report) :** Liste les endroits où le code actuel ne répond pas à 100% à l'exigence de qualité premium.
2. **Le correctif immédiat (Snippets) :** Fournis uniquement le code optimisé pour corriger les failles identifiées (ex: ajout d'un `debounce` sur la recherche, correction d'un Layout Shift sur les Skeletons).
3. **Le feu vert final :** Une fois ces corrections appliquées, valide que l'application est prête pour la production.
