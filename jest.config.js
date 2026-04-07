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
    // Transform ESM-only packages (chalk, execa, commander, etc.)
    'node_modules/(?!(chalk|execa|commander)/)',
  ],
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
