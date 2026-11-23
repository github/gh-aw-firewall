export function buildCliProxyAclSections(cliProxyIp?: string): {
  aclSection: string;
  accessSection: string;
} {
  const aclSection = cliProxyIp
    ? `acl from_cli_proxy src ${cliProxyIp}/32
acl cli_proxy_artifact_storage dstdomain .blob.core.windows.net`
    : '';
  const accessSection = cliProxyIp
    ? `# Allow the CLI proxy to follow GitHub artifact redirects without widening
# the agent's domain allowlist.
http_access allow from_cli_proxy cli_proxy_artifact_storage
`
    : '';

  return { aclSection, accessSection };
}
