export function getRunnerImageFamily(runnerImage: string): string {
  const parts = runnerImage.split('/');
  if (
    (parts.length !== 1 && parts.length !== 2) ||
    parts.some((part) => part === '' || !/^[A-Za-z0-9._-]+$/.test(part))
  ) {
    throw new Error(`runner image ${JSON.stringify(runnerImage)} is invalid`);
  }
  return parts[0];
}
