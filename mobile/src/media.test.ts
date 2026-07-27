import assert from 'node:assert/strict';
import test from 'node:test';

import { assertImageDimensions, sniffMediaKind } from './media';

const bytes = (prefix: number[], text = '') => Uint8Array.from([
  ...prefix,
  ...Array.from(text, (character) => character.charCodeAt(0)),
  ...Array(32).fill(0),
]);

test('media validation uses file signatures instead of provider MIME alone', () => {
  assert.equal(sniffMediaKind(bytes([0x89], 'PNG\r\n\x1a\n')), 'image');
  assert.equal(sniffMediaKind(bytes([0xff, 0xd8, 0xff])), 'image');
  assert.equal(sniffMediaKind(bytes([0, 0, 0, 24], 'ftypheic')), 'image');
  assert.equal(sniffMediaKind(bytes([0, 0, 0, 24], 'ftypmp42')), 'video');
  assert.equal(sniffMediaKind(bytes([0, 0, 0, 24], 'ftypqt  ')), 'video');
  assert.equal(sniffMediaKind(bytes([], 'RIFF0000AVI ')), null);
  assert.equal(sniffMediaKind(bytes([0x1a, 0x45, 0xdf, 0xa3])), null);
  assert.equal(sniffMediaKind(bytes([0, 0, 0, 24], 'ftypzzzz')), null);
  assert.equal(sniffMediaKind(bytes([], '<script>not media</script>')), null);
});

test('media validation rejects images that would decode beyond the local memory budget', () => {
  assert.doesNotThrow(() => assertImageDimensions(6_000, 4_000));
  assert.throws(() => assertImageDimensions(6_001, 4_000), /2400 万像素/);
  assert.throws(() => assertImageDimensions(8_193, 1), /2400 万像素/);
});
