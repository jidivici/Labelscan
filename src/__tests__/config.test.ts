import { validateApiBaseUrl } from '../config';

describe('API URL release guard', () => {
  it('rejects cleartext URLs in release builds', () => {
    expect(() => validateApiBaseUrl('http://api.example.test', false)).toThrow(
      'Release builds require an HTTPS',
    );
  });

  it('rejects missing or malformed release URLs', () => {
    expect(() => validateApiBaseUrl('', false)).toThrow(
      'Release builds require EXPO_PUBLIC_API_BASE_URL',
    );
    expect(() => validateApiBaseUrl('not-a-url', false)).toThrow('must be a valid URL');
    expect(() => validateApiBaseUrl('https://user:secret@example.test', false)).toThrow(
      'without credentials',
    );
  });

  it('allows local cleartext development and HTTPS releases', () => {
    expect(validateApiBaseUrl('http://192.168.1.20:8000', true)).toBe(
      'http://192.168.1.20:8000',
    );
    expect(validateApiBaseUrl('https://api.example.test', false)).toBe(
      'https://api.example.test',
    );
    expect(validateApiBaseUrl('https://api.example.test/', false)).toBe(
      'https://api.example.test',
    );
  });
});
