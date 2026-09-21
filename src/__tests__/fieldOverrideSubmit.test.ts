import AsyncStorage from '@react-native-async-storage/async-storage';

import { overrideField, ApiError } from '../services/api';
import { isGs1OwnedField, submitFieldOverrides } from '../services/fieldOverrideSubmit';
import { listAll, listDeadLetters } from '../services/outbox';

// Mock the network layer; the outbox runs against the in-memory AsyncStorage mock.
jest.mock('../services/api', () => {
  class ApiError extends Error {
    code: string;
    status: number;
    retriable: boolean;
    constructor(a: { code: string; status: number; message?: string; retriable?: boolean }) {
      super(a.message ?? '');
      this.code = a.code;
      this.status = a.status;
      this.retriable = a.retriable ?? false;
    }
  }
  return { ApiError, overrideField: jest.fn() };
});

jest.mock('../services/authStorage', () => ({
  captureActiveSession: jest.fn(async () => ({
    generation: 1,
    scopeKey: 'org-a:actor-a:portal-a:poissonnerie',
    signal: new AbortController().signal,
  })),
  getOperatorContext: jest.fn(async () => ({
    organizationId: 'org-a',
    actorId: 'actor-a',
    businessPortalId: 'portal-a',
    tradeCode: 'poissonnerie',
  })),
  isSessionFenceCurrent: jest.fn(() => true),
  operatorContextKey: jest.fn((context) =>
    [context.organizationId, context.actorId, context.businessPortalId, context.tradeCode].join(':'),
  ),
}));

const mockOverride = overrideField as jest.MockedFunction<typeof overrideField>;

const ok = {
  ingestion_id: 'i1',
  run_id: 'r2',
  field_name: 'x',
  value: 'v',
  validation_status: 'present',
  source: 'human',
  combined_confidence: 1,
  confidence_band: 'high',
  replayed: false,
};

beforeEach(async () => {
  mockOverride.mockReset();
  await AsyncStorage.clear();
});

describe('isGs1OwnedField', () => {
  it('identifies every GS1-owned field (barcode-exact)', () => {
    for (const f of ['batch_number', 'expiry_date', 'weight', 'gtin', 'packaging_date']) {
      expect(isGs1OwnedField(f)).toBe(true);
    }
  });

  it('does not flag free-text / LLM fields', () => {
    for (const f of ['FAO_area', 'supplier_name', 'scientific_name', 'allergens']) {
      expect(isGs1OwnedField(f)).toBe(false);
    }
  });
});

describe('submitFieldOverrides', () => {
  it('submits every correction, including GS1-owned fields tagged with force_gs1', async () => {
    mockOverride.mockResolvedValue(ok);

    const res = await submitFieldOverrides({
      ingestionId: 'i1',
      fields: [
        { field_name: 'FAO_area', value: '27.8.b.1' },
        { field_name: 'batch_number', value: 'LOT-CORRIGE' }, // workflow v1: GS1 editable too
        { field_name: 'supplier_name', value: 'Acme SARL' },
      ],
    });

    expect(res).toEqual({ submitted: 3, pending: 0 });
    expect(mockOverride).toHaveBeenCalledTimes(3);
    expect(mockOverride).toHaveBeenCalledWith(
      'i1',
      'FAO_area',
      '27.8.b.1',
      undefined,
      expect.objectContaining({
        idempotencyKey: expect.any(String),
        correlationId: expect.any(String),
        forceGs1: undefined,
      }),
    );
    // the GS1-owned field is sent WITH the explicit flag (server accepts + audits it).
    expect(mockOverride).toHaveBeenCalledWith(
      'i1',
      'batch_number',
      'LOT-CORRIGE',
      undefined,
      expect.objectContaining({ forceGs1: true }),
    );
  });

  it('forwards a cleared field as value=null', async () => {
    mockOverride.mockResolvedValue(ok);
    await submitFieldOverrides({ ingestionId: 'i2', fields: [{ field_name: 'allergens', value: null }] });
    expect(mockOverride).toHaveBeenCalledWith('i2', 'allergens', null, undefined, expect.anything());
  });

  it('leaves a transient failure pending on the outbox (not dead-lettered)', async () => {
    mockOverride.mockRejectedValue(
      new ApiError({ code: 'DEPENDENCY_UNAVAILABLE', status: 503, message: 'down', retriable: true }),
    );

    const res = await submitFieldOverrides({ ingestionId: 'i9', fields: [{ field_name: 'FAO_area', value: '37' }] });

    expect(res).toEqual({ submitted: 0, pending: 1 });
    const op = (await listAll()).find((o) => o.type === 'override_field');
    expect(op?.status).toBe('pending');
    expect(await listDeadLetters()).toHaveLength(0);
  });

  it('dead-letters a non-retryable failure', async () => {
    mockOverride.mockRejectedValue(
      new ApiError({ code: 'VALIDATION_ERROR', status: 400, message: 'bad', retriable: false }),
    );

    await submitFieldOverrides({ ingestionId: 'i9', fields: [{ field_name: 'FAO_area', value: 'x' }] });

    expect(await listDeadLetters()).toHaveLength(1);
  });

  it('never throws — a sync failure does not surface to the caller', async () => {
    mockOverride.mockRejectedValue(new Error('boom'));
    await expect(
      submitFieldOverrides({ ingestionId: 'i9', fields: [{ field_name: 'manufacturer_name', value: 'Maison Démo' }] }),
    ).resolves.toEqual({ submitted: 0, pending: 1 });
  });
});
