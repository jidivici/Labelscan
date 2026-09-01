-- Migration 0008: extracted_field GS1 provenance + GTIN field
-- See server/migrations/versions/0008_gs1_provenance.py for the actual migration.
-- This is the design reference DDL.

-- Extend source CHECK: add 'gs1' (barcode-exact, confidence 1.0, bypass evidence gate)
ALTER TABLE ingestion.extracted_field DROP CONSTRAINT extracted_field_source_check;
ALTER TABLE ingestion.extracted_field ADD CONSTRAINT extracted_field_source_check
    CHECK (source IN ('llm', 'human', 'gs1'));

-- Extend field_name CHECK: add 'gtin' (AI 01 — the product key from GS1 barcode)
ALTER TABLE ingestion.extracted_field DROP CONSTRAINT extracted_field_field_name_check;
ALTER TABLE ingestion.extracted_field ADD CONSTRAINT extracted_field_field_name_check
    CHECK (field_name IN (
        'product_name', 'commercial_designation', 'scientific_name',
        'batch_number', 'supplier_name', 'origin_country', 'FAO_area',
        'production_method', 'fishing_gear_or_farming_method', 'expiry_date',
        'packaging_date', 'storage_temperature', 'allergens', 'weight', 'price',
        'gtin'
    ));
