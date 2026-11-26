module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testTimeout: 30_000,
  moduleNameMapper: {
    '^(\\.\\.?:?/.+)\\.js$': '$1',
  },
  testMatch: ['**/tests/**/*.test.ts'],
};
