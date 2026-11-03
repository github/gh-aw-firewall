import * as yaml from 'js-yaml';
import { renderDockerCompose } from './compose-renderer';
import { DockerComposeConfig } from './types';

describe('renderDockerCompose', () => {
  const environment = {
    INVALID_EXPRESSION: '${warning.title}',
    BARE: '$NAME',
    BRACED: '${NAME}',
    DOUBLE: '$$',
    DEFAULT: '${NAME:-fallback}',
    MULTILINE: 'first $NAME\n"quoted" \'single\' `backticks` $(command)\n\n',
    EMPTY: '',
  };

  it('escapes every service environment without mutating canonical values', () => {
    const compose: DockerComposeConfig = {
      services: Object.fromEntries(
        ['agent', 'squid-proxy', 'api-proxy', 'cli-proxy', 'router', 'enclave-mcp-server']
          .map(name => [name, { container_name: name, environment }]),
      ),
      networks: {},
    };
    const original = JSON.stringify(compose);
    const rendered = renderDockerCompose(compose);
    const parsed = yaml.load(rendered) as DockerComposeConfig;

    for (const service of Object.values(parsed.services)) {
      expect(service.environment).toEqual(Object.fromEntries(
        Object.entries(environment).map(([key, value]) => [key, value.replace(/\$/g, () => '$$')]),
      ));
    }
    expect(JSON.stringify(compose)).toBe(original);
    expect(renderDockerCompose(compose)).toBe(rendered);
  });

  it('leaves non-environment interpolation and command escaping unchanged', () => {
    const compose: DockerComposeConfig = {
      services: {
        agent: {
          container_name: 'agent',
          image: 'agent:${TAG:-latest}',
          command: ['sh', '-c', 'echo "$$NAME"'],
          environment,
        },
        helper: { container_name: 'helper', image: 'helper:latest' },
      },
      networks: {},
    };
    const parsed = yaml.load(renderDockerCompose(compose)) as DockerComposeConfig;

    expect(parsed.services.agent.image).toBe(compose.services.agent.image);
    expect(parsed.services.agent.command).toEqual(compose.services.agent.command);
    expect(parsed.services.helper).toEqual(compose.services.helper);
  });
});
