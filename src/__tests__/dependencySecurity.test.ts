import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type Ast = { type: string; nodes?: Ast[]; value?: string };
const braces = require('braces') as Record<
  'parse' | 'compile' | 'expand' | 'stringify',
  (input: string | Ast, options?: Record<string, unknown>) => unknown
>;

describe('dependency security regressions', () => {
  it.each(['parse', 'compile', 'expand', 'stringify'] as const)(
    'rejects excessive brace and parenthesis nesting in %s',
    (method) => {
      for (const [open, close] of [['{', '}'], ['(', ')']]) {
        const pattern = open.repeat(4000) + 'a,b' + close.repeat(4000);
        expect(() => braces[method](pattern, { maxDepth: Infinity })).toThrow(
          expect.objectContaining({ code: 'ERR_BRACES_COMPLEXITY' }),
        );
      }
    },
  );

  it.each(['compile', 'expand', 'stringify'] as const)(
    'rejects deep and cyclic caller-supplied ASTs in %s',
    (method) => {
      let deep: Ast = { type: 'text', value: 'a' };
      for (let i = 0; i < 20000; i += 1) deep = { type: 'root', nodes: [deep] };
      const cyclic: Ast = { type: 'root', nodes: [] };
      cyclic.nodes!.push(cyclic);
      for (const ast of [deep, cyclic]) {
        expect(() => braces[method](ast)).toThrow(
          expect.objectContaining({ code: 'ERR_BRACES_COMPLEXITY' }),
        );
      }
    },
  );

  it('preserves ranges, alternatives and Metro/Jest file matching', () => {
    expect(braces.expand('file-{01..03}.{ts,tsx}')).toEqual([
      'file-01.ts', 'file-01.tsx', 'file-02.ts', 'file-02.tsx', 'file-03.ts', 'file-03.tsx',
    ]);
    const micromatch = require('micromatch') as (files: string[], patterns: string[]) => string[];
    expect(micromatch(
      ['src/a.ts', 'src/b.tsx', 'src/c.js', 'src/__mocks__/a.ts'],
      ['src/**/*.{ts,tsx}', '!**/__mocks__/**'],
    )).toEqual(['src/a.ts', 'src/b.tsx']);
  });

  it('loads NYC YAML through js-yaml 4 without the legacy sprintf-js dependency', async () => {
    const { loadNycConfig } = require('@istanbuljs/load-nyc-config') as {
      loadNycConfig(options: { cwd: string }): Promise<Record<string, unknown>>;
    };
    const directory = await mkdtemp(join(tmpdir(), 'labelscan-nyc-'));
    try {
      await writeFile(join(directory, 'package.json'), '{"name":"nyc-regression","private":true}');
      await writeFile(join(directory, '.nycrc.yml'), 'all: true\ninclude:\n  - src/**/*.ts\ncheck-coverage: true\n');
      expect(await loadNycConfig({ cwd: directory })).toMatchObject({
        all: true,
        include: ['src/**/*.ts'],
        checkCoverage: true,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(['\n', '\r', '\u2028', '\u2029'])(
    'rejects a line terminator after a shell comment (%j)',
    (terminator) => {
      const { quote } = require('shell-quote') as { quote(tokens: unknown[]): string };
      expect(() => quote(['echo', 'ok', { comment: 'x' }, `a${terminator}id;#`])).toThrow(TypeError);
    },
  );
});
