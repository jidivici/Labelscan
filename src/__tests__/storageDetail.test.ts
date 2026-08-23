import { getCatalogArticle } from '../services/catalogApi';
import { queryClient } from '../services/queryClient';
import { getArticleById } from '../services/storage';
import type { Article } from '../types/Article';

jest.mock('../services/catalogApi', () => ({
  getCatalogArticle: jest.fn(),
  listCatalogArticles: jest.fn(),
}));
jest.mock('../services/queryClient', () => ({
  queryClient: { getQueryData: jest.fn() },
}));

const mockedGetCatalogArticle = getCatalogArticle as jest.MockedFunction<typeof getCatalogArticle>;
const mockedGetQueryData = queryClient.getQueryData as jest.Mock;

function article(id: string, fields: Article['fields']): Article {
  return {
    id,
    source: 'backend_extraction',
    ingestion_id: `ing-${id}`,
    extraction_run_id: null,
    captured_at: '2026-08-21T18:00:00Z',
    photo_uri: null,
    barcode_raw: null,
    ingestion_status: 'confirmed',
    fields,
    saved_at: '2026-08-21T18:00:00Z',
    saved_by: null,
    raw_extraction_run: null,
  };
}

describe('getArticleById detail source', () => {
  beforeEach(() => {
    mockedGetCatalogArticle.mockReset();
    mockedGetQueryData.mockReset();
  });

  it('prefers the full server detail over the cached catalogue summary', async () => {
    const summary = article('batch-1', [
      { field_name: 'commercial_designation', value: 'Saumon', validation_status: 'present', combined_confidence: 1, confidence_band: 'high' },
    ]);
    const detail = article('batch-1', [
      ...summary.fields,
      { field_name: 'origin_country', value: 'Norvège', validation_status: 'present', combined_confidence: 1, confidence_band: 'high' },
    ]);
    mockedGetQueryData.mockReturnValue([summary]);
    mockedGetCatalogArticle.mockResolvedValue(detail);

    await expect(getArticleById('batch-1')).resolves.toEqual(detail);
    expect(mockedGetCatalogArticle).toHaveBeenCalledWith('batch-1');
  });

  it('keeps the cached summary only as an offline fallback', async () => {
    const summary = article('batch-1', []);
    mockedGetQueryData.mockReturnValue([summary]);
    mockedGetCatalogArticle.mockResolvedValue(null);

    await expect(getArticleById('batch-1')).resolves.toEqual(summary);
  });

  it('uses a complete optimistic local arrival without requesting an invalid pending id', async () => {
    const optimistic = article('pending-ing-1', []);
    mockedGetQueryData.mockReturnValue([optimistic]);

    await expect(getArticleById(optimistic.id)).resolves.toEqual(optimistic);
    expect(mockedGetCatalogArticle).not.toHaveBeenCalled();
  });
});
