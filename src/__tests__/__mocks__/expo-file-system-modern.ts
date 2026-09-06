export class File extends Blob {
  readonly uri: string;
  readonly name: string;

  constructor(uri: string) {
    super([], { type: uri.toLowerCase().endsWith('.jpg') ? 'image/jpeg' : '' });
    this.uri = uri;
    this.name = uri.split('/').pop() ?? '';
  }
}
