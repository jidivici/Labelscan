import { ApiError } from '../services/api';

describe('ApiError', () => {
  it('stores code, status, message, and correlationId', () => {
    const err = new ApiError({
      code: 'VALIDATION_ERROR',
      status: 400,
      message: 'bad request',
      correlationId: 'corr-1',
    });
    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err.status).toBe(400);
    expect(err.message).toBe('bad request');
    expect(err.correlationId).toBe('corr-1');
  });

  it('defaults retriable to false', () => {
    const err = new ApiError({ code: 'X', status: 400, message: '' });
    expect(err.retriable).toBe(false);
  });

  it('accepts explicit retriable=true', () => {
    const err = new ApiError({ code: 'X', status: 500, message: '', retriable: true });
    expect(err.retriable).toBe(true);
  });

  it('is an instance of Error', () => {
    const err = new ApiError({ code: 'X', status: 0, message: 'net' });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('ApiError');
  });
});
