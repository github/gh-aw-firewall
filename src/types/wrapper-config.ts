/**
 * Main wrapper configuration types grouped by domain.
 *
 * The monolithic WrapperConfigBase has been split into domain-scoped interfaces.
 * This file imports those interfaces and composes the final WrapperConfig type.
 */

import type { ContainerImageOptions } from './container-image-options';
import type { NetworkOptions } from './network-options';
import type { VolumeOptions } from './volume-options';
import type { SecurityOptions } from './security-options';
import type { ApiProxyOptions } from './api-proxy-options';
import type { CliProxyOptions } from './cli-proxy-options';
import type { RateLimitOptions } from './rate-limit-options';
import type { RuntimeOptions } from './runtime-options';

export type WrapperConfig =
  ContainerImageOptions
  & NetworkOptions
  & VolumeOptions
  & SecurityOptions
  & ApiProxyOptions
  & CliProxyOptions
  & RateLimitOptions
  & RuntimeOptions;
