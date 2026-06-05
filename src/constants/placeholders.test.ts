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

  it('matches the api-proxy copilot.js placeholder value', () => {
    const copilotJsPath = path.resolve(__dirname, '../../containers/api-proxy/providers/copilot-byok.js');
    const scriptContent = fs.readFileSync(copilotJsPath, 'utf8');
    const match = scriptContent.match(/COPILOT_PLACEHOLDER_TOKEN\s*=\s*'([^']+)'\s*\+\s*'([^']+)'\.repeat\((\d+)\)/);

    const reconstructed = match ? match[1] + match[2].repeat(parseInt(match[3], 10)) : undefined;
    expect(reconstructed).toBe(COPILOT_PLACEHOLDER_TOKEN);
  });
});
