import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadAwfFileConfig } from './config-file';

describe('loadAwfFileConfig', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-config-file-test-'));
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('loads JSON config files', () => {
    const filePath = path.join(testDir, 'awf.json');
    fs.writeFileSync(filePath, JSON.stringify({ logging: { logLevel: 'debug' } }));

    const result = loadAwfFileConfig(filePath);

    expect(result.logging?.logLevel).toBe('debug');
  });

  it('loads YAML config files', () => {
    const filePath = path.join(testDir, 'awf.yaml');
    fs.writeFileSync(filePath, 'network:\n  allowDomains:\n    - github.com\n');

    const result = loadAwfFileConfig(filePath);

    expect(result.network?.allowDomains).toEqual(['github.com']);
  });

  it('loads YML config files', () => {
    const filePath = path.join(testDir, 'awf.yml');
    fs.writeFileSync(filePath, 'logging:\n  logLevel: warn\n');

    const result = loadAwfFileConfig(filePath);

    expect(result.logging?.logLevel).toBe('warn');
  });

  it('loads config from stdin when path is "-"', () => {
    const result = loadAwfFileConfig('-', () => '{"network":{"allowDomains":["github.com"]}}');

    expect(result.network?.allowDomains).toEqual(['github.com']);
  });

  it('loads YAML from stdin when JSON parse fails', () => {
    const yamlContent = 'network:\n  allowDomains:\n    - example.com\n';
    const result = loadAwfFileConfig('-', () => yamlContent);

    expect(result.network?.allowDomains).toEqual(['example.com']);
  });

  it('loads extensionless config file as JSON', () => {
    const filePath = path.join(testDir, 'awfconfig');
    fs.writeFileSync(filePath, JSON.stringify({ logging: { logLevel: 'error' } }));

    const result = loadAwfFileConfig(filePath);

    expect(result.logging?.logLevel).toBe('error');
  });

  it('loads extensionless config file as YAML when JSON fails', () => {
    const filePath = path.join(testDir, 'awfconfig');
    fs.writeFileSync(filePath, 'logging:\n  logLevel: info\n');

    const result = loadAwfFileConfig(filePath);

    expect(result.logging?.logLevel).toBe('info');
  });

  it('throws helpful validation errors', () => {
    const filePath = path.join(testDir, 'awf.json');
    fs.writeFileSync(filePath, JSON.stringify({ container: { agentTimeout: -1 } }));

    expect(() => loadAwfFileConfig(filePath)).toThrow('config.container.agentTimeout must be a positive integer');
  });

  it('throws on invalid JSON file', () => {
    const filePath = path.join(testDir, 'awf.json');
    fs.writeFileSync(filePath, '{invalid json}');

    expect(() => loadAwfFileConfig(filePath)).toThrow('Failed to parse AWF config from');
  });

  it('throws on invalid YAML file', () => {
    const filePath = path.join(testDir, 'awf.yaml');
    // Intentionally malformed YAML to exercise parse-error handling
    fs.writeFileSync(filePath, ': invalid yaml\n  bad indent:\n');

    // May throw on parse or validation
    expect(() => loadAwfFileConfig(filePath)).toThrow();
  });

  it('includes path in validation error message', () => {
    const filePath = path.join(testDir, 'awf.json');
    fs.writeFileSync(filePath, JSON.stringify({ unknown: true }));

    expect(() => loadAwfFileConfig(filePath)).toThrow(`Invalid AWF config at ${filePath}`);
  });

  it('includes "stdin" in validation error message for stdin input', () => {
    expect(() => loadAwfFileConfig('-', () => '{"unknown": true}')).toThrow('Invalid AWF config at stdin');
  });
});
