module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/../integration'],
  testMatch: ['**/*.test.ts'],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
  transform: {
    '^.+\\.ts$': 'ts-jest',
    '^.+\\.js$': 'babel-jest',
  },
  transformIgnorePatterns: [
    // Transform ESM-only packages (chalk, execa, commander, and their transitive deps)
    'node_modules/(?!(chalk|execa|commander|@sindresorhus/merge-streams|@sec-ant/readable-stream|figures|get-stream|human-signals|is-plain-obj|is-stream|is-unicode-supported|npm-run-path|parse-ms|path-key|pretty-ms|strip-final-newline|unicorn-magic|yoctocolors)/)',
  ],
  // Custom resolver to handle ESM-only packages with exports maps that lack "require" conditions
  resolver: '<rootDir>/../../jest-resolver.js',
  collectCoverageFrom: [
    '../integration/**/*.ts',
    '!**/*.test.ts',
    '!**/node_modules/**',
  ],
  setupFilesAfterEnv: ['<rootDir>/jest.setup.ts'],
  testTimeout: 120000, // 2 minutes per test (firewall tests can be slow)
  verbose: true,
  maxWorkers: 1, // Run tests serially to avoid Docker conflicts
};
