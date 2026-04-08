/**
 * Test to verify Jest ESM configuration is working correctly.
 *
 * Validates that ESM-only packages (chalk v5, execa v9) are properly
 * transformed and resolved in the Jest test environment via:
 * - babel-jest transformation of ESM → CJS
 * - transformIgnorePatterns allowing ESM packages to be transformed
 * - Custom jest-resolver.js handling exports maps with only "import" conditions
 */

// Import ESM-only packages to validate transformation pipeline
import chalk from 'chalk';
import { execa } from 'execa';

describe('Jest ESM Configuration', () => {
  describe('chalk v5 ESM compatibility', () => {
    it('should be able to import chalk', () => {
      expect(chalk).toBeDefined();
      expect(typeof chalk.blue).toBe('function');
      expect(typeof chalk.red).toBe('function');
      expect(typeof chalk.green).toBe('function');
    });

    it('should be able to use chalk functions', () => {
      const blueText = chalk.blue('test');
      expect(blueText).toBeDefined();
      expect(typeof blueText).toBe('string');
    });
  });

  describe('execa v9 ESM compatibility', () => {
    it('should be able to import execa named export', () => {
      expect(execa).toBeDefined();
      expect(typeof execa).toBe('function');
    });
  });

  describe('transformIgnorePatterns configuration', () => {
    it('should be configured to transform ESM packages in node_modules', () => {
      // Verifies jest.config.js has transformIgnorePatterns set up correctly
      // so babel-jest transforms chalk/execa/commander and their transitive deps
      expect(chalk).toBeDefined();

      const result = chalk.green('success');
      expect(result).toBeTruthy();
    });
  });

  describe('babel configuration', () => {
    it('should be configured for ESM→CJS transformation', () => {
      // Verifies babel.config.js and jest-resolver.js work together
      // to transform and resolve ESM-only packages
      expect(chalk).toBeDefined();
      expect(chalk.blue).toBeDefined();

      const text = 'ESM transformation infrastructure ready';
      const coloredText = chalk.blue(text);
      expect(coloredText).toContain(text);
    });
  });
});
