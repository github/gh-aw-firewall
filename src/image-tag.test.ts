import { parseImageTag, buildRuntimeImageRef, IMAGE_DIGEST_KEYS } from './image-tag';

const VALID_DIGEST = 'sha256:' + 'a'.repeat(64);

describe('parseImageTag', () => {
  describe('when given valid input', () => {
    it('should parse legacy tag format', () => {
      const result = parseImageTag('0.25.18');
      expect(result.tag).toBe('0.25.18');
      expect(result.digests).toEqual({});
    });

    it('should parse tag with single digest', () => {
      const result = parseImageTag(`0.25.18,squid=${VALID_DIGEST}`);
      expect(result.tag).toBe('0.25.18');
      expect(result.digests.squid).toBe(VALID_DIGEST);
    });

    it('should parse tag with multiple digests', () => {
      const agentDigest = 'sha256:' + 'b'.repeat(64);
      const result = parseImageTag(`0.25.18,squid=${VALID_DIGEST},agent=${agentDigest}`);
      expect(result.tag).toBe('0.25.18');
      expect(result.digests.squid).toBe(VALID_DIGEST);
      expect(result.digests.agent).toBe(agentDigest);
    });

    it('should handle all supported digest keys', () => {
      const entries = IMAGE_DIGEST_KEYS.map((k, i) => `${k}=sha256:${'a'.repeat(63)}${i}`).join(
        ','
      );
      const result = parseImageTag(`latest,${entries}`);
      expect(result.tag).toBe('latest');
      for (const key of IMAGE_DIGEST_KEYS) {
        expect(result.digests[key]).toBeDefined();
      }
    });

    it('should trim whitespace around tag and entries', () => {
      const result = parseImageTag(`  v1.0 , squid = ${VALID_DIGEST} `);
      expect(result.tag).toBe('v1.0');
      expect(result.digests.squid).toBe(VALID_DIGEST);
    });

    it('should skip empty digest entries (trailing comma)', () => {
      const result = parseImageTag(`0.25.18,squid=${VALID_DIGEST},`);
      expect(result.tag).toBe('0.25.18');
      expect(result.digests.squid).toBe(VALID_DIGEST);
    });
  });

  describe('when given invalid input', () => {
    it('should throw when tag is empty string', () => {
      expect(() => parseImageTag('')).toThrow('tag cannot be empty');
    });

    it('should throw when tag is whitespace only', () => {
      expect(() => parseImageTag('   ')).toThrow('tag cannot be empty');
    });

    it('should throw when tag portion is empty after split (leading comma)', () => {
      expect(() => parseImageTag(`,squid=${VALID_DIGEST}`)).toThrow('tag cannot be empty');
    });

    it('should throw for digest entry without equals sign', () => {
      expect(() => parseImageTag('v1.0,squid')).toThrow('Expected format');
    });

    it('should throw for digest entry with equals at position 0 (empty key)', () => {
      expect(() => parseImageTag(`v1.0,=${VALID_DIGEST}`)).toThrow('Expected format');
    });

    it('should throw for digest entry with equals at last position (empty value)', () => {
      expect(() => parseImageTag('v1.0,squid=')).toThrow('Expected format');
    });

    it('should throw for unrecognized digest key', () => {
      expect(() => parseImageTag(`v1.0,unknown=${VALID_DIGEST}`)).toThrow(
        'Invalid --image-tag digest key "unknown"'
      );
    });

    it('should throw for digest that is not sha256 format', () => {
      expect(() => parseImageTag('v1.0,squid=md5:abc')).toThrow(
        'Expected lowercase sha256:<64-hex>'
      );
    });

    it('should throw for sha256 digest with wrong length', () => {
      expect(() => parseImageTag('v1.0,squid=sha256:abc123')).toThrow(
        'Expected lowercase sha256:<64-hex>'
      );
    });

    it('should throw for sha256 digest with uppercase hex', () => {
      expect(() => parseImageTag(`v1.0,squid=sha256:${'A'.repeat(64)}`)).toThrow(
        'Expected lowercase sha256:<64-hex>'
      );
    });

    it('should throw for sha256 digest with non-hex characters', () => {
      expect(() => parseImageTag(`v1.0,squid=sha256:${'g'.repeat(64)}`)).toThrow(
        'Expected lowercase sha256:<64-hex>'
      );
    });
  });
});

describe('buildRuntimeImageRef', () => {
  describe('when given valid input', () => {
    it('should build ref without digest when none provided', () => {
      const parsed = parseImageTag('0.25.18');
      const ref = buildRuntimeImageRef('ghcr.io/github/gh-aw-firewall', 'squid', parsed);
      expect(ref).toBe('ghcr.io/github/gh-aw-firewall/squid:0.25.18');
    });

    it('should build ref with digest when provided', () => {
      const parsed = parseImageTag(`0.25.18,squid=${VALID_DIGEST}`);
      const ref = buildRuntimeImageRef('ghcr.io/github/gh-aw-firewall', 'squid', parsed);
      expect(ref).toBe(`ghcr.io/github/gh-aw-firewall/squid:0.25.18@${VALID_DIGEST}`);
    });

    it('should build ref for agent image', () => {
      const agentDigest = 'sha256:' + 'c'.repeat(64);
      const parsed = parseImageTag(`latest,agent=${agentDigest}`);
      const ref = buildRuntimeImageRef('registry.example.com/myorg', 'agent', parsed);
      expect(ref).toBe(`registry.example.com/myorg/agent:latest@${agentDigest}`);
    });

    it('should build ref without digest when image has no matching digest', () => {
      const parsed = parseImageTag(`0.25.18,squid=${VALID_DIGEST}`);
      const ref = buildRuntimeImageRef('ghcr.io/github/gh-aw-firewall', 'agent', parsed);
      expect(ref).toBe('ghcr.io/github/gh-aw-firewall/agent:0.25.18');
    });
  });

  describe('when given invalid image name', () => {
    it('should throw for unknown image name', () => {
      const parsed = parseImageTag('0.25.18');
      expect(() =>
        buildRuntimeImageRef('ghcr.io/github/gh-aw-firewall', 'unknown-image', parsed)
      ).toThrow('Invalid runtime image name "unknown-image"');
    });

    it('should mention supported names in error', () => {
      const parsed = parseImageTag('0.25.18');
      expect(() =>
        buildRuntimeImageRef('ghcr.io/github/gh-aw-firewall', 'bad', parsed)
      ).toThrow(IMAGE_DIGEST_KEYS.join(', '));
    });
  });
});
