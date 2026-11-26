// Plan 125: @swc/jest strips types, like ts-jest already did here (isolatedModules: true puts
// ts-jest in transpile-only mode), only faster. Type errors in src are caught by `npm run typecheck`.
module.exports = {
  testEnvironment: 'node',
  testTimeout: 30_000,
  transform: {
    '^.+\\.tsx?$': [
      '@swc/jest',
      {
        jsc: { parser: { syntax: 'typescript' }, target: 'es2022' },
        module: { type: 'commonjs' },
      },
    ],
  },
  moduleNameMapper: {
    '^(\\.\\.?:?/.+)\\.js$': '$1',
  },
  testMatch: ['**/tests/**/*.test.ts'],
};
