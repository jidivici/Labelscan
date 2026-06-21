import AsyncStorage from '@react-native-async-storage/async-storage';

import { overrideField, ApiError } from '../services/api';
import { isHumanEditableField, submitFieldOverrides } from '../services/fieldOverrideSubmit';
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

describe('isHumanEditableField', () => {
  it('rejects every GS1-owned field (barcode-exact, not human-editable)', () => {
    for (const f of ['batch_number', 'expiry_date', 'weight', 'gtin', 'packaging_date']) {
      expect(isHumanEditableField(f)).toBe(false);
    }
  });

  it('accepts free-text / LLM fields', () => {
    for (const f of ['FAO_area', 'supplier_name', 'scientific_name', 'allergens', 'price']) {
      expect(isHumanEditableField(f)).toBe(true);
    }
  });
});

describe('submitFieldOverrides', () => {
  it('submits editable corrections and skips GS1-owned fields', async () => {
    mockOverride.mockResolvedValue(ok);

    const res = await submitFieldOverrides({
      ingestionId: 'i1',
      fields: [
        { field_name: 'FAO_area', value: '27.8.b.1' },
        { field_name: 'batch_number', value: 'HACK' }, // GS1-owned → never sent
        { field_name: 'supplier_name', value: 'Acme SARL' },
      ],
    });

    expect(res).toEqual({ submitted: 2, pending: 0, skipped: 1 });
    expect(mockOverride).toHaveBeenCalledTimes(2);
    expect(mockOverride).toHaveBeenCalledWith(
      'i1',
      'FAO_area',
      '27.8.b.1',
      undefined,
      expect.objectContaining({ idempotencyKey: expect.any(String), correlationId: expect.any(String) }),
    );
    // the barcode-exact field is never pushed (it would 409 server-side)
    expect(mockOverride).not.toHaveBeenCalledWith(
      'i1',
      'batch_number',
      expect.anything(),
      expect.anything(),
      expect.anything(),
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

    expect(res).toEqual({ submitted: 0, pending: 1, skipped: 0 });
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
      submitFieldOverrides({ ingestionId: 'i9', fields: [{ field_name: 'price', value: '8.95 EUR' }] }),
    ).resolves.toEqual({ submitted: 0, pending: 1, skipped: 0 });
  });
});
