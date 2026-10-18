import { createHmac, randomBytes } from 'crypto';
import type { WrapperConfig } from '../types';

const secrets = new WeakMap<WrapperConfig, string>();

export function getOrCreateEnclaveModelBudgetSecret(config: WrapperConfig): string | undefined {
  const agent = config.enclaves?.executors.agent;
  if (!agent?.enabled || (
    agent.maxModelRequests === undefined &&
    agent.maxModelTokens === undefined
  )) return undefined;

  let secret = secrets.get(config);
  if (!secret) {
    secret = randomBytes(32).toString('hex');
    secrets.set(config, secret);
  }
  return secret;
}

export function createEnclaveModelBudgetToken(
  secret: string | undefined,
  invocationId: string,
  maxRequests?: number,
  maxTokens?: number,
): string | undefined {
  if (secret === undefined) return undefined;
  const claims = {
    v: 1,
    invocationId,
    maxRequests: maxRequests ?? null,
    maxTokens: maxTokens ?? null,
  };
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = createHmac('sha256', Buffer.from(secret, 'hex'))
    .update(payload)
    .digest('base64url');
  return 'Bearer ' + payload + '.' + signature;
}
