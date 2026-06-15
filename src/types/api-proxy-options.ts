/**
 * API proxy options composed from focused sub-interfaces.
 */

import type { ApiProxyCredentialOptions } from './api-proxy-credential-options';
import type { ApiProxyRoutingOptions } from './api-proxy-routing-options';
import type { ApiProxyModelOptions } from './api-proxy-model-options';
import type { ApiProxyDiagnosticsOptions } from './api-proxy-diagnostics-options';

export type ApiProxyOptions =
  ApiProxyCredentialOptions
  & ApiProxyRoutingOptions
  & ApiProxyModelOptions
  & ApiProxyDiagnosticsOptions;

export type {
  ApiProxyCredentialOptions,
  ApiProxyRoutingOptions,
  ApiProxyModelOptions,
  ApiProxyDiagnosticsOptions,
};
