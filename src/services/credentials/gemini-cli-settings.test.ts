import * as path from 'path';
import * as http from 'http';
import { buildGeminiCredentialEnv } from './gemini-credential-env';
import type { WrapperConfig } from '../../types';
import {
  GEMINI_CLI_SYSTEM_SETTINGS_PATH,
  buildGeminiSystemSettingsContent,
} from './gemini-cli-settings';

interface Entry {
  uid: number;
  mode: number;
  symlink?: boolean;
}

// Isolated stat/realpath fixture for Gemini CLI 0.64.0's POSIX system-settings
// policy: check the file, each lexical ancestor and any canonical target/ancestors.
function acceptedByGemini(
  file: string,
  entries: Record<string, Entry>,
  canonicalFile = file,
): boolean {
  const check = (candidate: string): boolean => {
    const entry = entries[candidate];
    return Boolean(entry && entry.uid === 0 && (entry.mode & 0o022) === 0);
  };
  const checkPath = (candidate: string): boolean => {
    for (let dir = path.dirname(candidate); ; dir = path.dirname(dir)) {
      if (!check(dir)) return false;
      if (dir === path.dirname(dir)) break;
    }
    return check(candidate);
  };
  return checkPath(file) && (canonicalFile === file || checkPath(canonicalFile));
}

describe('Gemini CLI 0.64.0 system-settings security fixture', () => {
  const system = GEMINI_CLI_SYSTEM_SETTINGS_PATH;
  const safe: Record<string, Entry> = {
    '/': { uid: 0, mode: 0o755 },
    '/etc': { uid: 0, mode: 0o755 },
    '/etc/awf': { uid: 0, mode: 0o755 },
    '/etc/awf/gemini-cli': { uid: 0, mode: 0o755 },
    [system]: { uid: 0, mode: 0o644 },
  };

  it('rejects the old UID-1001 home path and accepts the protected system path', () => {
    const home = '/home/runner/.awf/gemini-cli-system-settings.json';
    const entries = {
      ...safe,
      '/home': { uid: 0, mode: 0o755 },
      '/home/runner': { uid: 1001, mode: 0o755 },
      '/home/runner/.awf': { uid: 1001, mode: 0o755 },
      [home]: { uid: 1001, mode: 0o644 },
    };
    expect(acceptedByGemini(home, entries)).toBe(false);
    expect(acceptedByGemini(system, entries)).toBe(true);
    expect(JSON.parse(buildGeminiSystemSettingsContent()).security.auth.selectedType).toBe('gemini-api-key');
  });

  describe('Gemini proxy auth-pin component fixture', () => {
    it('loads the API-key selection and reaches only a local fake proxy as UID 1001', async () => {
      if (process.getuid?.() !== 1001) return;

      const env = buildGeminiCredentialEnv({
        config: { enableApiProxy: true, geminiApiKey: 'fake-key' } as WrapperConfig,
        proxyIp: '127.0.0.1',
      });
      const authType = JSON.parse(buildGeminiSystemSettingsContent()).security.auth.selectedType;
      expect(env.GEMINI_CLI_SYSTEM_SETTINGS_PATH).toBe(GEMINI_CLI_SYSTEM_SETTINGS_PATH);
      expect(authType).toBe('gemini-api-key');
      expect(env.GEMINI_API_KEY).toBe('gemini-api-key-placeholder-for-credential-isolation');
      expect(Object.values(env)).not.toContain('fake-key');

      const requests: string[] = [];
      const server = http.createServer((request, response) => {
        requests.push(request.url || '');
        response.writeHead(200);
        response.end('fake-proxy-response');
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      try {
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('Expected a local TCP proxy');
        const proxyUrl = new URL('/models', env.GOOGLE_GEMINI_BASE_URL);
        proxyUrl.port = String(address.port);
        const body = await new Promise<string>((resolve, reject) => {
          http.get(proxyUrl, (response) => {
            let data = '';
            response.on('data', (chunk: string) => { data += chunk; });
            response.on('end', () => resolve(data));
          }).on('error', reject);
        });
        expect(body).toBe('fake-proxy-response');
        expect(requests).toEqual(['/models']);
      } finally {
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      }
    });
  });

  it('rejects a root-owned leaf below an untrusted ancestor', () => {
    expect(acceptedByGemini(system, {
      ...safe, '/etc/awf': { uid: 1001, mode: 0o755 },
    })).toBe(false);
    expect(acceptedByGemini(system, {
      ...safe, '/etc/awf': { uid: 0, mode: 0o775 },
    })).toBe(false);
  });

  it('rejects group/other-writable files and insecure symlink or canonical paths', () => {
    expect(acceptedByGemini(system, {
      ...safe, [system]: { uid: 0, mode: 0o664 },
    })).toBe(false);
    expect(acceptedByGemini(system, {
      ...safe, '/etc/awf': { uid: 1001, mode: 0o755, symlink: true },
    })).toBe(false);
    const canonical = '/tmp/runner/settings.json';
    expect(acceptedByGemini(system, {
      ...safe,
      '/tmp': { uid: 0, mode: 0o1777 },
      '/tmp/runner': { uid: 1001, mode: 0o755 },
      [canonical]: { uid: 0, mode: 0o644 },
    }, canonical)).toBe(false);
  });
});
