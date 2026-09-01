# LabelScan API security checks

Import `LabelScan-API-Security.postman_collection.json` into Postman and run the
collection. Its default `baseUrl` is `https://label-scan.fr` and every request is
read-only or deliberately rejected before processing, so no business data is created.

Expected result: all five requests and all tests pass. The public health endpoint must
return `200`; documentation must return `404`; anonymous business access, forged identity
headers, and anonymous ingestion must each return `401 UNAUTHENTICATED`.

The upload byte-boundary proofs are automated in
`server/tests/test_image_validation.py`: JPEG SOI/EOI, PNG signature/IEND/CRC, WebP
RIFF length/chunks, truncation, MIME mismatch, and appended payload rejection.
