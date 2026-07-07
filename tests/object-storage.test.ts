import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ApiError } from '@/lib/openwook/api';
import { readObjectBuffer, storeImportSourceFile, validateFileSignatureForTest } from '@/lib/openwook/object-storage';

describe('import file signature validation', () => {
  it('accepts docx zip signatures and rejects mislabeled docx files', () => {
    expect(() => validateFileSignatureForTest('.docx', Buffer.from('PK\x03\x04'))).not.toThrow();
    expect(() => validateFileSignatureForTest('.docx', Buffer.from('not a docx'))).toThrow(ApiError);
  });

  it('rejects binary-looking txt files', () => {
    expect(() => validateFileSignatureForTest('.txt', Buffer.from('plain text'))).not.toThrow();
    expect(() => validateFileSignatureForTest('.txt', Buffer.from([65, 0, 66]))).toThrow(ApiError);
  });

  it('stores uploads without keeping the full file buffer on the returned object', async () => {
    const stored = await storeImportSourceFile(
      1,
      1,
      new File(['plain import text'], 'questions.txt', { type: 'text/plain' })
    );

    expect('buffer' in stored).toBe(false);
    expect((await readObjectBuffer(stored.relativePath)).toString('utf8')).toBe('plain import text');
  });

  it('rejects binary-looking txt uploads even when the null byte is outside the signature prefix', async () => {
    const prefix = new Uint8Array(5000).fill(65);
    const payload = new Blob([prefix, new Uint8Array([0, 66])], { type: 'text/plain' });
    const file = new File([payload], 'binary.txt', { type: 'text/plain' });

    await expect(storeImportSourceFile(1, 1, file)).rejects.toMatchObject({ code: 'UNSUPPORTED_FILE_TYPE' });
  });

  it('marks the external mount path as a Turbopack tracing boundary', () => {
    const source = readFileSync('lib/openwook/object-storage.ts', 'utf8');
    expect(source).toContain('turbopackIgnore');
  });

  it('suppresses the remaining NFT warning only at the Next config boundary', () => {
    const source = readFileSync('next.config.ts', 'utf8');

    expect(source).toContain('ignoreIssue');
    expect(source).toContain('Encountered unexpected file in NFT list');
  });
});
