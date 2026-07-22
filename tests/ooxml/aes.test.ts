/**
 * AES-CBC decryption primitive (Office package decryption). Vectors
 * from FIPS-197 (single-block AES-128/256) and NIST SP 800-38A
 * (multi-block CBC chaining).
 */
import { describe, it, expect } from 'vitest';
import { aesCbcDecrypt } from '../../src/ooxml/aes.js';

const fromHex = (h: string): Uint8Array => new Uint8Array(h.match(/../g)!.map((x) => parseInt(x, 16)));
const hex = (u: Uint8Array): string => [...u].map((b) => b.toString(16).padStart(2, '0')).join('');
const ZERO_IV = new Uint8Array(16);

describe('aesCbcDecrypt', () => {
  it('FIPS-197 AES-128 single block', () => {
    const key = fromHex('000102030405060708090a0b0c0d0e0f');
    const ct = fromHex('69c4e0d86a7b0430d8cdb78070b4c55a');
    expect(hex(aesCbcDecrypt(key, ZERO_IV, ct))).toBe('00112233445566778899aabbccddeeff');
  });

  it('FIPS-197 AES-256 single block', () => {
    const key = fromHex('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f');
    const ct = fromHex('8ea2b7ca516745bfeafc49904b496089');
    expect(hex(aesCbcDecrypt(key, ZERO_IV, ct))).toBe('00112233445566778899aabbccddeeff');
  });

  it('NIST SP 800-38A CBC-AES256 (4 chained blocks)', () => {
    const key = fromHex('603deb1015ca71be2b73aef0857d77811f352c073b6108d72d9810a30914dff4');
    const iv = fromHex('000102030405060708090a0b0c0d0e0f');
    const ct = fromHex(
      'f58c4c04d6e5f1ba779eabfb5f7bfbd6' +
        '9cfc4e967edb808d679f777bc6702c7d' +
        '39f23369a9d9bacfa530e26304231461' +
        'b2eb05e2c39be9fcda6c19078c6a9d1b',
    );
    expect(hex(aesCbcDecrypt(key, iv, ct))).toBe(
      '6bc1bee22e409f96e93d7e117393172a' +
        'ae2d8a571e03ac9c9eb76fac45af8e51' +
        '30c81c46a35ce411e5fbc1191a0a52ef' +
        'f69f2445df4f9b17ad2b417be66c3710',
    );
  });

  it('rejects a non-block-multiple input', () => {
    expect(() => aesCbcDecrypt(new Uint8Array(32), ZERO_IV, new Uint8Array(17))).toThrow();
  });
});
