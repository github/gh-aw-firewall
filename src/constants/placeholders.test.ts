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

  it('matches the api-proxy copilot-byok.js placeholder value', () => {
    const copilotByokJsPath = path.resolve(__dirname, '../../containers/api-proxy/providers/copilot-byok.js');
    const scriptContent = fs.readFileSync(copilotByokJsPath, 'utf8');
    // Value is constructed as: 'ghu_' + 'a'.repeat(36)
    const match = scriptContent.match(/COPILOT_PLACEHOLDER_TOKEN\s*=\s*'([^']+)'\s*\+\s*'([^']+)'\.repeat\((\d+)\)/);

    const reconstructed = match ? match[1] + match[2].repeat(Number(match[3])) : undefined;
    expect(reconstructed).toBe(COPILOT_PLACEHOLDER_TOKEN);
  });
});
