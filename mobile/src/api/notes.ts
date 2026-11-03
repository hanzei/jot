import type { FileImportType, ImportResponse } from '@jot/shared';
import { jot } from './jot';
import { rnFilePart } from './upload';

export interface ImportFile {
  uri: string;
  name: string;
  mimeType?: string | null | undefined;
}

function inferMimeType(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.zip')) return 'application/zip';
  return 'application/json';
}

export async function importFile(file: ImportFile, importType: FileImportType): Promise<ImportResponse> {
  const formData = new FormData();
  formData.append('import_type', importType);
  formData.append('file', rnFilePart(file.uri, file.name, file.mimeType || inferMimeType(file.name)));

  return jot.notes.import(formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });
}
