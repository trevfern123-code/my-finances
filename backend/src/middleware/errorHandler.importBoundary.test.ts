import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

// The global error handler is loaded by every route. It classifies the read path's failures, and it
// must do so WITHOUT pulling in the read path itself: the data service, the Supabase client or the
// environment configuration. (An earlier I1 pass imported a cursor error from the read path here; the
// classes the handler needs now live in pure modules.) This test follows the handler's import graph in
// the source and fails if that boundary is crossed again.

const SRC = resolve(__dirname, '..');

/** The relative imports of one source file, resolved to files under `src`. */
function importsOf(file: string): string[] {
  const source = readFileSync(file, 'utf8');
  const found: string[] = [];
  // `import … from '…'`, `export … from '…'` and bare `import '…'`; type-only imports are erased at
  // build time and cannot load a module, so they are not edges.
  const pattern = /^\s*(import|export)\s+(?!type\b)(?:[^'";]*?\s+from\s+)?['"](\.[^'"]+)['"]/gm;
  for (const match of source.matchAll(pattern)) {
    const target = join(dirname(file), match[2]);
    const candidate = [`${target}.ts`, join(target, 'index.ts')].find((path) => existsSync(path));
    if (candidate === undefined) throw new Error(`cannot resolve ${match[2]} from ${file}`);
    found.push(candidate);
  }
  return found;
}

function closureOf(entry: string): string[] {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    queue.push(...importsOf(file));
  }
  return Array.from(seen)
    .map((file) => relative(SRC, file).split(sep).join('/'))
    .sort();
}

describe('errorHandler import boundary', () => {
  const closure = closureOf(join(SRC, 'middleware', 'errorHandler.ts'));

  it('reaches the error classifier and the pure modules that define the errors', () => {
    expect(closure).toContain('middleware/semanticErrors.ts');
    expect(closure).toContain('services/semanticAggregation.ts');
    expect(closure).toContain('services/fetchAllPages.ts');
  });

  it('never reaches the data service, the read path, the Supabase client or the environment configuration', () => {
    const forbidden = closure.filter(
      (file) =>
        file.startsWith('config/') ||
        file.startsWith('controllers/') ||
        ['services/dataService.ts', 'services/semanticReadPath.ts', 'services/financialSnapshot.ts', 'services/cardPaymentStateReader.ts'].includes(file)
    );
    expect(forbidden).toEqual([]);
  });

  it('the walker itself sees an import when there is one (it is not vacuous)', () => {
    // The read path does import the data service: the same walker must find that edge.
    expect(closureOf(join(SRC, 'services', 'semanticReadPath.ts'))).toContain('services/dataService.ts');
    expect(closureOf(join(SRC, 'services', 'semanticReadPath.ts'))).toContain('config/supabase.ts');
  });
});
