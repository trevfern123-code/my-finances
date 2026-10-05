import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CLIENT_API_LEVEL } from './appUpdate';
import { EFFECT_MEASURES } from './semanticModel';

// Financial Semantics Phase B, integration slice I2. The two workspaces share no code, so this test
// reads the backend's own source to hold the client to the contract it was written against: the API
// level both sides speak, the level at which the server publishes role-aware fields, and the list
// of drill-down measures. If the backend changes one of these, this fails until the client follows.

const backend = (path: string) => readFileSync(new URL(`../../../backend/src/${path}`, import.meta.url), 'utf8');

function constant(source: string, name: string): number {
  const match = new RegExp(`export const ${name} = (\\d+);`).exec(source);
  if (!match) throw new Error(`${name} not found`);
  return Number(match[1]);
}

describe('API level 2', () => {
  const middleware = backend('middleware/clientApiLevel.ts');
  const semanticResponse = backend('controllers/semanticResponse.ts');

  it('this client speaks level 2, the level the backend advertises', () => {
    expect(CLIENT_API_LEVEL).toBe(2);
    expect(constant(middleware, 'API_LEVEL')).toBe(CLIENT_API_LEVEL);
  });

  it('level 2 is at or above the level from which the server publishes role-aware fields', () => {
    expect(CLIENT_API_LEVEL).toBeGreaterThanOrEqual(constant(semanticResponse, 'SEMANTIC_FIELDS_MIN_CLIENT_API_LEVEL'));
  });

  it('older clients are still served: the minimum client level stays 0', () => {
    expect(constant(middleware, 'MIN_CLIENT_API_LEVEL')).toBe(0);
  });
});

describe('drill-down measures', () => {
  it('the client lists exactly the measures the backend publishes, in the same order', () => {
    const source = backend('services/semanticAggregation.ts');
    const block = /export const CASH_FLOW_MEASURES = \[([\s\S]*?)\] as const;/.exec(source);
    if (!block) throw new Error('CASH_FLOW_MEASURES not found');
    const published = Array.from(block[1].matchAll(/'([a-z_]+)'/g), (m) => m[1]);
    expect(published.length).toBeGreaterThan(10);
    expect([...EFFECT_MEASURES]).toEqual(published);
  });
});
