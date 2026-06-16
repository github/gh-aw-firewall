/**
 * GitHub platform deployment type options.
 */

export interface PlatformOptions {
  /**
   * The GitHub deployment type. Explicitly declares the environment so AWF can
   * apply correct auth behavior (e.g. 'token' vs 'Bearer' prefix for Copilot API)
   * without relying on heuristic detection from GITHUB_SERVER_URL.
   *
   * - 'github.com' — GitHub.com (default)
   * - 'ghes' — GitHub Enterprise Server (on-premises)
   * - 'ghec' — GitHub Enterprise Cloud (*.ghe.com tenants)
   * - 'ghec-self-hosted' — GHEC with self-hosted runners
   *
   * When set to 'ghes', the api-proxy uses 'token' prefix for Copilot auth
   * regardless of the resolved API target hostname.
   */
  platformType?: 'github.com' | 'ghes' | 'ghec' | 'ghec-self-hosted';
}
