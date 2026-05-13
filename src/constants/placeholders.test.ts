import * as fs from 'fs';
import * as path from 'path';
import { COPILOT_PLACEHOLDER_TOKEN } from './placeholders';

describe('COPILOT_PLACEHOLDER_TOKEN', () => {
  it('matches the health-check shell placeholder value', () => {
    const healthCheckScriptPath = path.resolve(__dirname, '../../containers/agent/api-proxy-health-check.sh');
    const scriptContent = fs.readFileSync(healthCheckScriptPath, 'utf8');
    const match = scriptContent.match(/COPILOT_PLACEHOLDER_TOKEN="([^"]+)"/);

    expect(match?.[1]).toBe(COPILOT_PLACEHOLDER_TOKEN);
  });
});
