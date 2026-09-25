import { describe, expect, it } from 'vitest';
import { API_LEVEL, MIN_CLIENT_API_LEVEL, parseClientApiLevel } from './clientApiLevel';

describe('parseClientApiLevel', () => {
  it('a missing header is reported as missing (the caller treats it as legacy level 0)', () => {
    expect(parseClientApiLevel(undefined)).toEqual({ kind: 'missing' });
  });

  it.each([
    ['0', 0],
    ['1', 1],
    ['42', 42],
    ['999999', 999999],
  ])('accepts the canonical integer %s', (raw, level) => {
    expect(parseClientApiLevel(raw)).toEqual({ kind: 'valid', level });
  });

  it.each([
    ['empty', ''],
    ['whitespace only', ' '],
    ['leading space', ' 1'],
    ['trailing space', '1 '],
    ['leading zero', '01'],
    ['negative', '-1'],
    ['explicit plus sign', '+1'],
    ['decimal', '1.0'],
    ['exponent', '1e2'],
    ['hex', '0x1'],
    ['word', 'one'],
    ['number with trailing junk', '1abc'],
    ['header sent twice (Node joins duplicates)', '1, 1'],
    ['seven digits', '1000000'],
    ['Infinity', 'Infinity'],
    ['NaN', 'NaN'],
  ])('rejects %s rather than coercing it', (_label, raw) => {
    expect(parseClientApiLevel(raw)).toEqual({ kind: 'invalid' });
  });
});

describe('production policy constants', () => {
  it('this release serves level 1 and still accepts every existing (legacy, level 0) client', () => {
    expect(API_LEVEL).toBe(1);
    expect(MIN_CLIENT_API_LEVEL).toBe(0);
  });
});
