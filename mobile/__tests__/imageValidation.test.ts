import { validateImageFile, imageMaxMB, IMAGE_MAX_MB } from '../src/utils/imageValidation';
import { UPLOAD_MAX_BYTES } from '@jot/shared';

describe('validateImageFile', () => {
  it('accepts an allowed image type under the size limit', () => {
    expect(validateImageFile({ mimeType: 'image/png', sizeBytes: 1024 })).toBeNull();
  });

  it('accepts a file with unknown size (server is the source of truth)', () => {
    expect(validateImageFile({ mimeType: 'image/jpeg' })).toBeNull();
  });

  it.each(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])('accepts %s', (mimeType) => {
    expect(validateImageFile({ mimeType })).toBeNull();
  });

  it('rejects a disallowed type (e.g. SVG, which can carry script)', () => {
    expect(validateImageFile({ mimeType: 'image/svg+xml' })).toBe('wrongType');
  });

  it('rejects a non-image type', () => {
    expect(validateImageFile({ mimeType: 'application/pdf' })).toBe('wrongType');
  });

  it('rejects a file over the size limit', () => {
    expect(validateImageFile({ mimeType: 'image/png', sizeBytes: UPLOAD_MAX_BYTES + 1 })).toBe('tooLarge');
  });

  it('accepts a file exactly at the size limit', () => {
    expect(validateImageFile({ mimeType: 'image/png', sizeBytes: UPLOAD_MAX_BYTES })).toBeNull();
  });

  it('exposes the limit in whole megabytes for error copy', () => {
    expect(IMAGE_MAX_MB).toBe(Math.floor(UPLOAD_MAX_BYTES / (1024 * 1024)));
  });
});

describe('imageMaxMB', () => {
  it('rounds down so the displayed limit never overstates what is actually accepted', () => {
    // 1.5MB must read "1MB", not "2MB" — a rejected 1.6MB file must not look
    // like a bug against a displayed 2MB limit.
    expect(imageMaxMB(1.5 * 1024 * 1024)).toBe(1);
  });

  it('matches IMAGE_MAX_MB for the default (whole-megabyte) limit', () => {
    expect(imageMaxMB(UPLOAD_MAX_BYTES)).toBe(IMAGE_MAX_MB);
  });
});
