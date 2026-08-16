jest.mock('../services/api', () => ({
  ApiError: class ApiError extends Error {},
  createIngestion: jest.fn(),
}));

jest.mock('../services/outbox', () => ({
  enqueueCreateIngestion: jest.fn(),
  getOperation: jest.fn(),
  markFailed: jest.fn(),
  markInFlight: jest.fn(),
  markSucceeded: jest.fn(),
  operationMatchesOperatorContext: jest.fn(() => true),
}));

import { createIngestion } from '../services/api';
import { markInFlight, markSucceeded } from '../services/outbox';
import { executeCreateIngestionOp } from '../services/ingestionSubmit';

const createIngestionMock = jest.mocked(createIngestion);
const markInFlightMock = jest.mocked(markInFlight);
const markSucceededMock = jest.mocked(markSucceeded);

describe('ingestion portal isolation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('never forwards locally persisted portal/trade metadata in an ingestion upload', async () => {
    markInFlightMock.mockResolvedValue({
      id: 'op-1',
      type: 'create_ingestion',
      idempotencyKey: 'idem-1',
      correlationId: 'corr-1',
      status: 'in_flight',
      attempt_count: 1,
      next_attempt_at: '2026-08-04T00:00:00Z',
      last_error_code: null,
      last_error_message: null,
      result: null,
      created_at: '2026-08-04T00:00:00Z',
      updated_at: '2026-08-04T00:00:00Z',
      payload: {
        file: { uri: 'file:///label.jpg', name: 'label.jpg', type: 'image/jpeg' },
        barcode_raw: '0123456789012',
        client_captured_at: '2026-08-04T08:00:00Z',
        // Simulate a malicious/legacy payload: the execution boundary must whitelist.
        business_portal_id: 'must-not-leave-device',
        trade_code: 'boucherie',
      },
    } as never);
    createIngestionMock.mockResolvedValue({
      ingestion_id: 'ing-1',
      status: 'raw_stored',
      replayed: false,
      correlation_id: 'corr-1',
    });
    markSucceededMock.mockResolvedValue({} as never);

    await expect(executeCreateIngestionOp('op-1')).resolves.toEqual({
      kind: 'succeeded',
      ingestionId: 'ing-1',
      replayed: false,
    });

    expect(createIngestionMock).toHaveBeenCalledWith(
      { uri: 'file:///label.jpg', name: 'label.jpg', type: 'image/jpeg' },
      {
        barcode_raw: '0123456789012',
        client_captured_at: '2026-08-04T08:00:00Z',
      },
      { idempotencyKey: 'idem-1', correlationId: 'corr-1' },
    );
    expect(createIngestionMock.mock.calls[0][1]).not.toHaveProperty('business_portal_id');
    expect(createIngestionMock.mock.calls[0][1]).not.toHaveProperty('trade_code');
  });
});
