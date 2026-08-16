/** Select compact server derivatives without changing local captured-file URIs. */
export function thumbnailPhotoUri(uri: string): string {
  if (!uri.includes('/v1/arrivals/') || !uri.includes('/image')) return uri;
  const separator = uri.includes('?') ? '&' : '?';
  return `${uri}${separator}variant=thumbnail`;
}
