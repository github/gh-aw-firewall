export function expectGatewayHttpAcceptRules<T extends (...args: any[]) => any>(
  mockedExeca: jest.MockedFunction<T>,
  gatewayIp: string
): void {
  expect(mockedExeca).toHaveBeenCalledWith('iptables', [
    '-t', 'filter', '-A', 'FW_WRAPPER',
    '-p', 'tcp', '-d', gatewayIp, '--dport', '80',
    '-j', 'ACCEPT',
  ]);
  expect(mockedExeca).toHaveBeenCalledWith('iptables', [
    '-t', 'filter', '-A', 'FW_WRAPPER',
    '-p', 'tcp', '-d', gatewayIp, '--dport', '443',
    '-j', 'ACCEPT',
  ]);
}
