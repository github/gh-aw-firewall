/**
 * @fileoverview ESLint rule to detect unsafe execa() usage patterns
 *
 * This rule detects potentially unsafe usage of the execa library that could
 * lead to command injection vulnerabilities, specifically:
 *
 * 1. Template literals with expressions in the command argument
 * 2. String concatenation in the command argument
 * 3. Non-literal command arguments (variables)
 *
 * Safe patterns (not flagged):
 * - Literal strings as command: execa('docker', ['...'])
 * - Static array of arguments: execa('ls', ['-la'])
 * - Variables for options object: execa('ls', args, options)
 *   (as long as the command itself is a literal)
 *
 * @author AWF Security
 */

'use strict';

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Detect unsafe execa() usage patterns that could lead to command injection',
      category: 'Security',
      recommended: true,
    },
    schema: [],
    messages: {
      unsafeTemplateCommand: 'Avoid template literals with expressions in execa command. Use literal strings to prevent command injection.',
      unsafeConcatCommand: 'Avoid string concatenation in execa command. Use literal strings to prevent command injection.',
      unsafeVariableCommand: 'Avoid using variables for execa command. Use literal strings to prevent command injection.',
      unsafeTemplateArg: 'Avoid template literals with expressions in execa arguments. Pass arguments as separate array elements.',
      unsafeConcatArg: 'Avoid string concatenation in execa arguments. Pass arguments as separate array elements.',
      unsafeShellOption: 'Using shell: true with execa can be dangerous. Ensure user input is properly sanitized.',
    },
  },
  create(context) {
    /**
     * Checks if a node represents an execa call
     * Handles: execa(), execa.sync(), execa.command(), execa.commandSync()
     */
    function isExecaCall(node) {
      if (node.type !== 'CallExpression') return false;

      const callee = node.callee;

      // Direct call: execa(...)
      if (callee.type === 'Identifier' && callee.name === 'execa') {
        return true;
      }

      // Method call: execa.sync(), execa.command(), execa.commandSync()
      if (
        callee.type === 'MemberExpression' &&
        callee.object.type === 'Identifier' &&
        callee.object.name === 'execa'
      ) {
        return true;
      }

      return false;
    }

    /**
     * Checks if a node contains template literal expressions
     */
    function hasTemplateExpressions(node) {
      if (node.type === 'TemplateLiteral' && node.expressions.length > 0) {
        return true;
      }
      return false;
    }

    /**
     * Checks if a node is a binary expression (string concatenation)
     */
    function isConcatenation(node) {
      if (node.type === 'BinaryExpression' && node.operator === '+') {
        return true;
      }
      return false;
    }

    /**
     * Checks if a node is a variable reference
     */
    function isVariable(node) {
      return node.type === 'Identifier';
    }

    /**
     * Checks if the options object contains shell: true
     */
    function hasShellTrue(node) {
      if (!node || node.type !== 'ObjectExpression') return false;

      for (const prop of node.properties) {
        if (
          prop.type === 'Property' &&
          prop.key.type === 'Identifier' &&
          prop.key.name === 'shell' &&
          prop.value.type === 'Literal' &&
          prop.value.value === true
        ) {
          return true;
        }
      }
      return false;
    }

    /**
     * Validates arguments array for unsafe patterns
     */
    function checkArgsArray(argsNode) {
      if (!argsNode || argsNode.type !== 'ArrayExpression') return;

      for (const element of argsNode.elements) {
        if (!element) continue;

        if (hasTemplateExpressions(element)) {
          context.report({
            node: element,
            messageId: 'unsafeTemplateArg',
          });
        } else if (isConcatenation(element)) {
          context.report({
            node: element,
            messageId: 'unsafeConcatArg',
          });
        }
        // We don't flag variables in args array since that's the safe pattern
        // for passing dynamic values (compared to string interpolation)
      }
    }

    return {
      CallExpression(node) {
        if (!isExecaCall(node)) return;

        const args = node.arguments;
        if (args.length === 0) return;

        const commandArg = args[0];

        // Check the command (first argument) for unsafe patterns
        if (hasTemplateExpressions(commandArg)) {
          context.report({
            node: commandArg,
            messageId: 'unsafeTemplateCommand',
          });
        } else if (isConcatenation(commandArg)) {
          context.report({
            node: commandArg,
            messageId: 'unsafeConcatCommand',
          });
        } else if (isVariable(commandArg)) {
          // Variable as command name is suspicious but might be intentional
          // Only report if not a common pattern
          context.report({
            node: commandArg,
            messageId: 'unsafeVariableCommand',
          });
        }

        // Check arguments array (second argument) for unsafe patterns
        if (args.length >= 2) {
          const argsArray = args[1];
          checkArgsArray(argsArray);
        }

        // Check for shell: true in options
        // Options can be in args[2] if args[1] is an array, or args[1] if it's an object
        let optionsArg = null;
        if (args.length >= 3) {
          optionsArg = args[2];
        } else if (args.length === 2 && args[1].type === 'ObjectExpression') {
          optionsArg = args[1];
        }
        if (hasShellTrue(optionsArg)) {
          context.report({
            node: optionsArg,
            messageId: 'unsafeShellOption',
          });
        }
      },
    };
  },
};
