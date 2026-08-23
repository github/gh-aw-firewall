import * as fs from 'fs';
import * as path from 'path';

const dockerfilePath = path.resolve(__dirname, '../../containers/agent/Dockerfile');

describe('agent Dockerfile security hardening', () => {
  it('strips and verifies file capabilities on raw-network utilities', () => {
    const dockerfile = fs.readFileSync(dockerfilePath, 'utf-8');
    const hardeningBlock = dockerfile.match(
      /for binary in \/usr\/bin\/ping \/usr\/bin\/mtr-packet; do[\s\S]*?done && \\/
    )?.[0];

    expect(hardeningBlock).toBeDefined();
    expect(hardeningBlock).toContain('setcap -r "$binary"');
    expect(hardeningBlock).toContain('getcap "$binary"');
    expect(hardeningBlock).toContain('exit 1');
  });
});
