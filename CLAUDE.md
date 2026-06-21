# claude.md — Architecture Frontend, Refonte UI, Search & Haiku Prompting
**Date :** 21 Juin 2026
**Modèle d'exécution :** Claude Opus 4.8 (Lead Architect & AI Prompt Engineer)

## 🧠 Déploiement des Agents Custom
1. **Frontend System Architect :** Architecture scalable, logique de recherche omnisciente.
2. **UX/UI Minimalist & Technical Writer :** Interface épurée, français métier, focus sur la photo et la vitesse perçue.
3. **AI Prompt Engineer :** Spécialiste OCR pour Haiku 4.5 (FAO ultra-précise).
4. **Security DevOps :** Préparation de commits propres, sans clés privées.

## 🎯 Directives d'implémentation strictes

**1. Clean UI Radicale & "No-Nonsense"**
- **Interdiction absolue** des éléments suivants dans la vue d'enregistrement et les détails d'articles :
  - Pas de tag "Modifié" ou "Édité" (la validation manuelle devient la vérité absolue).
  - Pas de tag "À vérifier".
  - Pas de pourcentage de validation ou de score de confiance de l'IA.
- Élimine les sous-titres et descriptions verbeuses. Les labels métier suffisent.
- Uniformisation globale : Poids en `Kg`, températures en `°C`, dates au format `21 juin 2026`.

**2. Refonte "Page Enregistrement" (Vitesse & Photo)**
- **Mise en valeur de la photo :** Parfaitement découpée (`object-fit: cover`, angles arrondis), visuellement agréable et centrale, sans casser la sobriété globale.
- **Vitesse perçue (Chargement en Cascade) :** L'utilisateur ne doit pas attendre Haiku.
  - Étape 1 : Affichage immédiat de la photo et des datas décodées instantanément via GS1-128 (Lot, GTIN, Poids).
  - Étape 2 : Skeletons Loading fluides sur les champs complexes (FAO, Nom, etc.).
  - Étape 3 : Remplacement des Skeletons dès la résolution de l'OCR Haiku.

**3. Page d'Accueil & Moteur de Recherche**
- **Tri Accueil :** Affichage en liste groupée par `Jour d'enregistrement` > puis triée par `Nom commun de poisson` par ordre alphabétique au sein de la journée.
- **Omni-Search :** Implémentation d'une barre de recherche globale capable de requêter tous les champs possibles de la DB enregistrés par labels (Numéro de lot, espèce, zone FAO, etc.).

**4. Prompting Haiku (FAO) & Sécurité Git**
- **Prompt Haiku 4.5 :** Rédige le prompt système exact pour extraire la zone FAO avec **tous ses déterminants** (Zone majeure, Sous-zone, Division, Sous-division, ex: 27.8.b.1) en croisant avec le texte brut.
- **Sécurité :** Tout le code généré pour le commit doit exclure les clés d'API (utilisation stricte de variables d'environnement).

## 📦 Livrables Attendus
1. Architecture frontend, store/hook de l'Omni-Search, et composant `HomePage` (trié).
2. Composant `SaveArticleView` (cascade loading, design photo, zéro tags/pourcentages IA).
3. Le prompt système exact de Haiku 4.5 pour l'extraction FAO.
4. Les commandes git/scripts prêts à commiter (sans secrets).
