module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/scripts'],
  testMatch: ['**/__tests__/**/*.ts', '**/*.test.ts'],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/**/*.test.ts',
  ],
  moduleFileExtensions: ['ts', 'js', 'json'],
  transform: {
    '^.+\\.ts$': 'ts-jest',
    '^.+\\.js$': 'babel-jest',
  },
  transformIgnorePatterns: [
    // Transform ESM-only packages (chalk, execa, commander, and their transitive deps)
    'node_modules/(?!(chalk|execa|commander|@sindresorhus/merge-streams|@sec-ant/readable-stream|figures|get-stream|human-signals|is-plain-obj|is-stream|is-unicode-supported|npm-run-path|parse-ms|path-key|pretty-ms|strip-final-newline|unicorn-magic|yoctocolors)/)',
  ],
  // Custom resolver to handle ESM-only packages with exports maps that lack "require" conditions
  resolver: '<rootDir>/jest-resolver.js',
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html', 'json-summary'],
  coverageThreshold: {
    global: {
      branches: 30,
      functions: 35,
      lines: 38,
      statements: 38,
    },
  },
  // Parallel test execution - use 50% of available CPUs to balance speed and resource usage
  // Unit tests are isolated and safe to run in parallel
  maxWorkers: '50%',
};
