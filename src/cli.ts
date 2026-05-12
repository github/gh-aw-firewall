#!/usr/bin/env node

import { program } from './cli-options';
import { createMainAction } from './commands/main-action';
import { registerSubcommands } from './commands/subcommands';

program.action(createMainAction(program.getOptionValueSource.bind(program)));
registerSubcommands(program);

// Only parse arguments if this file is run directly (not imported as a module)
if (require.main === module) {
  program.parse();
}
