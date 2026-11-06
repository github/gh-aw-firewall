#!/usr/bin/env node
import './tls-trust-policy';

import { program } from './cli-options';
import { createMainAction } from './commands/main-action';
import { registerSubcommands } from './commands/subcommands';
import { withEarlyStartupDiagnostics } from './logs/early-startup-diagnostics';

program.action(createMainAction(program.getOptionValueSource.bind(program)));
registerSubcommands(program);

// Only parse arguments if this file is run directly (not imported as a module)
if (require.main === module) {
  withEarlyStartupDiagnostics('configuration', () => program.parse());
}
