// Shared hoisted dependency mocks for config-writer test suites.

// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('fs', () => require('./fs-mock-factory.test-utils').fsMockFactory());

// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('../ssl-bump', () => require('./config-writer-test-harness.test-utils').sslBumpMockFactory());

// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('../domain-matchers', () => require('./config-writer-test-harness.test-utils').domainMatchersMockFactory());

// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('../host-env', () => require('./fs-mock-factory.test-utils').hostEnvMockFactory({ SQUID_PORT: 3128 }));

// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('../host-identity', () => require('./fs-mock-factory.test-utils').hostIdentityMockFactory());

// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('../squid-config', () => require('./config-writer-test-harness.test-utils').squidConfigMockFactory());

// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('../compose-generator', () => require('./config-writer-test-harness.test-utils').composeGeneratorMockFactory());
