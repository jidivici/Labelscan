import { __seedFile } from './expo-file-system-legacy';

export class File extends Blob {
  readonly uri: string;
  readonly name: string;

  constructor(uri: string) {
    super([], { type: uri.toLowerCase().endsWith('.jpg') ? 'image/jpeg' : '' });
    this.uri = uri;
    this.name = uri.split('/').pop() ?? '';
  }

  write(_content: string | Uint8Array): void {
    __seedFile(this.uri);
  }
}
