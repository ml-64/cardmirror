/**
 * SHA-512 primitive (used by the Office-decryption key derivation).
 * Known-answer vectors from FIPS 180-4 plus a multi-block case — the
 * hand-rolled hi/lo implementation must match a reference bit-for-bit
 * or every derived key is wrong.
 */
import { describe, it, expect } from 'vitest';
import { sha512 } from '../../src/ooxml/sha512.js';

const hex = (u: Uint8Array): string => [...u].map((b) => b.toString(16).padStart(2, '0')).join('');
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('sha512', () => {
  it('empty string', () => {
    expect(hex(sha512(enc('')))).toBe(
      'cf83e1357eefb8bdf1542850d66d8007d620e4050b5715dc83f4a921d36ce9ce' +
        '47d0d13c5d85f2b0ff8318d2877eec2f63b931bd47417a81a538327af927da3e',
    );
  });

  it('"abc"', () => {
    expect(hex(sha512(enc('abc')))).toBe(
      'ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a' +
        '2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f',
    );
  });

  it('two-block message (896-bit)', () => {
    expect(
      hex(sha512(enc('abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu'))),
    ).toBe(
      '8e959b75dae313da8cf4f72814fc143f8f7779c6eb9f7fa17299aeadb6889018' +
        '501d289e4900f7e4331b99dec4b5433ac7d329eeb6dd26545e96e55b874be909',
    );
  });

  it('1000 × "a"', () => {
    expect(hex(sha512(enc('a'.repeat(1000))))).toBe(
      '67ba5535a46e3f86dbfbed8cbbaf0125c76ed549ff8b0b9e03e0c88cf90fa634' +
        'fa7b12b47d77b694de488ace8d9a65967dc96df599727d3292a8d9d447709c97',
    );
  });

  it('length boundary at 111/112 bytes (padding edge)', () => {
    // 111 bytes fits the length in the same block; 112 forces a new one.
    expect(hex(sha512(enc('a'.repeat(111))))).toHaveLength(128);
    expect(hex(sha512(enc('a'.repeat(112))))).toHaveLength(128);
    expect(hex(sha512(enc('a'.repeat(111)))) === hex(sha512(enc('a'.repeat(112))))).toBe(false);
  });
});
