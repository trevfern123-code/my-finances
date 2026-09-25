import { describe, expect, it } from 'vitest';
import { bodyParserClientError } from './errorHandler';

describe('bodyParserClientError', () => {
  it.each([
    ['entity.parse.failed', 400, 'malformed_json'],
    ['entity.too.large', 413, 'payload_too_large'],
    ['request.size.invalid', 400, 'invalid_request_body'],
    ['request.aborted', 400, 'invalid_request_body'],
    ['encoding.unsupported', 415, 'unsupported_request_body'],
    ['charset.unsupported', 415, 'unsupported_request_body'],
  ])('maps body-parser %s (%i) to a client error with a fixed message', (type, status, code) => {
    const result = bodyParserClientError(Object.assign(new Error(`parser detail that must not leak: ${type}`), { type, status }));

    expect(result).toMatchObject({ status, code });
    expect(result!.message).not.toContain('must not leak');
  });

  it.each([
    ['a body-parser stream fault (500)', Object.assign(new Error('x'), { type: 'stream.not.readable', status: 500 })],
    ['a known type carrying a 5xx status', Object.assign(new Error('x'), { type: 'entity.parse.failed', status: 500 })],
    ['an unknown type', Object.assign(new Error('x'), { type: 'something.else', status: 400 })],
    ['a prototype key used as a type', Object.assign(new Error('x'), { type: 'toString', status: 400 })],
    ['an ordinary application error', new Error('database unavailable')],
    ['a status without a type', Object.assign(new Error('x'), { status: 400 })],
    ['a non-object', 'boom'],
    ['null', null],
  ])('leaves %s to the ordinary 500 path', (_label, err) => {
    expect(bodyParserClientError(err)).toBeNull();
  });
});
