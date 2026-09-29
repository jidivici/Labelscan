import pytest

from labelscan.contexts.ingestion.domain.input_validation import (
    validate_human_field_value,
)
from labelscan.contexts.ingestion.domain.interim_fields import extract_interim_fields
from labelscan.contexts.ingestion.domain.label_dates import normalize_label_date


@pytest.mark.parametrize(('raw', 'expected'), [
    ('20/JUN/26', '2026-06-20'), ('Jun 20, 2026', '2026-06-20'),
    ('1er février 2026', '2026-02-01'), ('July 1st, 26', '2026-07-01'),
    ('2026/06/20', '2026-06-20'), ('20.06.26', '2026-06-20'),
    ('06/20/2026', '2026-06-20'), ('20260620', '2026-06-20'),
    ('20062026', '2026-06-20'), ('29/02/24', '2024-02-29'),
])
def test_manual_date_boundary_accepts_label_formats(raw, expected):
    assert validate_human_field_value('packaging_date', raw) == expected


@pytest.mark.parametrize('raw', ['29/02/2026', '31 Apr 26', '20 Jungle 2026', 'June 2026', '2026-06', '260620'])
def test_manual_dates_never_invent_a_calendar_component(raw):
    with pytest.raises(ValueError):
        validate_human_field_value('packaging_date', raw)


def test_ocr_order_is_conservative_and_manual_order_is_french():
    assert normalize_label_date('04/05/26') is None
    assert validate_human_field_value('packaging_date', '04/05/26') == '2026-05-04'
    assert normalize_label_date('04/04/26') == '2026-04-04'


@pytest.mark.parametrize(('label', 'expected'), [
    ('Production date: Jun 20, 2026', '2026-06-20'),
    ('Pêché le 20/06/26', '2026-06-20'),
    ('Préparé le 1er février 2026', '2026-02-01'),
    ('Frozen on 20/JUN/26', '2026-06-20'),
    ('Date de congélation: 20260620', '2026-06-20'),
    ('Packed on 2026-06-22 Production date 20 Jun 2026', '2026-06-22'),
    ('Production date 20 Jun 2026 Frozen on 22 Jun 2026', '2026-06-20'),
    ('Packed on 04/05/26 Production date 20 Jun 2026', None),
    ('Packed on June 2026 Frozen on 22 Jun 2026', None),
    ('Packed on 31/02/2026', None),
    ('Packed on 20 Jun 2026 Packed on 21 Jun 2026', None),
    ('Packed on 20 Jun 2026 Packed on 04/05/26', None),
    ('Best before 20 Jun 2026', None), ('DLC: 20/06/26', None),
    ('Pack date\nDLC 20/06/26', None), ('20 Jun 2026', None),
])
def test_available_date_priority_and_expiry_exclusion(label, expected):
    fields = {field.name: field.value for field in extract_interim_fields(label)}
    assert fields.get('packaging_date') == expected


def test_multiline_fao_is_saved_without_losing_divisions():
    assert validate_human_field_value('FAO_area', 'FAO: 27.8.b.1;\n27.8.c') == 'FAO: 27.8.b.1; 27.8.c'
