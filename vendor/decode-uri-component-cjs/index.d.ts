/**
 * Decode a URI component without throwing for malformed percent-encoded input.
 */
declare function decodeUriComponent(encodedURI: string): string;

export = decodeUriComponent;
