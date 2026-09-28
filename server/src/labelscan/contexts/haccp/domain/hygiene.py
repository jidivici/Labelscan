"""Daily work reminders derived from the supplied PMS, June 2017.

A completion records an operator's declaration, never inferred label compliance.
"""

from dataclasses import dataclass
from datetime import date, timedelta


@dataclass(frozen=True)
class HygieneTask:
    code: str
    title: str
    instructions: str
    source_pages: str
    frequency: str = "daily"
    optional: bool = False

    def period(self, day: date) -> date:
        if self.frequency == "monthly":
            return day.replace(day=1)
        if self.frequency == "weekly":
            return day - timedelta(days=day.weekday())
        return day


TASKS = (
    HygieneTask(
        "reception",
        "Valider la réception",
        "Vérifier la propreté du camion, la température des produits, la fraîcheur, les emballages, l’étiquetage, le lot et la DLC. Consigner les mesures, le fournisseur, le produit contrôlé et la décision : réception, réserve ou refus. Une validation couvre le rappel du jour du rayon ; elle ne certifie pas chaque lot.",
        "1–2",
    ),
    HygieneTask(
        "temperature_am",
        "Températures — matin",
        "Relever et consigner les températures des chambres froides, du laboratoire, de l’étal et des meubles de vente. Indiquer les équipements, produits, mesures et actions correctives. Si suivi automatique sous alarme : préciser la référence du relevé hebdomadaire.",
        "5–6",
    ),
    HygieneTask(
        "temperature_pm",
        "Températures — après-midi",
        "Effectuer le second relevé des températures et consigner les mesures par équipement et les actions correctives. Si suivi automatique sous alarme : préciser la référence du relevé hebdomadaire.",
        "5–6",
    ),
    HygieneTask(
        "freshness",
        "Fraîcheur, tailles et parasites",
        "Contrôler la fraîcheur, la taille ou le calibre des produits concernés et l’absence d’Anisakis dans les filets. Consigner produit, fournisseur, lot, résultat et action corrective selon le PMS du magasin.",
        "3–4",
    ),
    HygieneTask(
        "cleaning",
        "Nettoyage et désinfection",
        "Suivre le planning de nettoyage du magasin : chambre froide, laboratoire, plonge, vente et matériel. Consigner les zones traitées, produit, dosage, température, temps d’action et rinçage. Reporter aussi les opérations périodiques prévues au planning.",
        "7–8",
    ),
    HygieneTask(
        "tank",
        "Vivier — contrôle hebdomadaire",
        "Si le rayon dispose d’un vivier : consigner la salinité, la température et les actions correctives selon le PMS du magasin.",
        "9–10",
        "weekly",
        True,
    ),
    HygieneTask(
        "cooking",
        "Cuisson et refroidissement",
        "Si cuisson aujourd’hui : consigner pour chaque préparation le produit, la quantité, le lot, la DLC, les heures et températures de sortie de cuisson et de refroidissement ainsi que les actions correctives. Respecter les barèmes du magasin.",
        "11–12",
        "daily",
        True,
    ),
    HygieneTask(
        "thermometer",
        "Vérifier le thermomètre",
        "Vérification mensuelle dans un bain d’eau glacée. Consigner la date, la valeur lue, l’identifiant du thermomètre et toute action corrective. Tenir compte de la correction lors des relevés, selon le PMS du magasin.",
        "2, 6, 12",
        "monthly",
    ),
)


def tasks_for_trade(trade: str) -> tuple[HygieneTask, ...]:
    # The provided source applies to seafood only.
    return TASKS if trade == "poissonnerie" else ()
