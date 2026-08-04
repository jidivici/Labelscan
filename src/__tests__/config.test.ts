import { validateApiBaseUrl } from '../config';

describe('API URL release guard', () => {
  it('rejects cleartext URLs in release builds', () => {
    expect(() => validateApiBaseUrl('http://api.example.test', false)).toThrow(
      'Release builds require an HTTPS',
    );
  });

  it('allows local cleartext development and HTTPS releases', () => {
    expect(validateApiBaseUrl('http://192.168.1.20:8000', true)).toBe(
      'http://192.168.1.20:8000',
    );
    expect(validateApiBaseUrl('https://api.example.test', false)).toBe(
      'https://api.example.test',
    );
  });
});
