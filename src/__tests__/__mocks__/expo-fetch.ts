export type FetchRequestInit = RequestInit;

export const fetch = jest.fn(function fetch(
  input: string,
  init?: RequestInit,
): Promise<Response> {
  return globalThis.fetch(input, init);
});
