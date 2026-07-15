export const gvisorRuntimeSentinels = [
  'containerRuntime\\":\\"gvisor\\"',
  '--container-runtime gvisor',
];

export const bunJitDisableFlag = '--env BUN_JSC_useJIT=0 ';

export const awfCommandPrefixRegex = /((?:sudo -E )?awf )(?=--config )/g;

export function injectBunJitDisableFlagForGvisorAwf(content: string): string {
  if (content.includes(bunJitDisableFlag)) {
    return content;
  }

  if (!gvisorRuntimeSentinels.some(sentinel => content.includes(sentinel))) {
    return content;
  }

  return content.replace(awfCommandPrefixRegex, `$1${bunJitDisableFlag}`);
}
