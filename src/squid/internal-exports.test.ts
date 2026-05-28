import * as aclGenerator from './acl-generator';
import * as accessRules from './access-rules';
import * as configSections from './config-sections';

describe('squid internal helper exports', () => {
  it('does not export access-rules helpers directly', () => {
    expect((accessRules as Record<string, unknown>).generateProtocolRules).toBeUndefined();
    expect((accessRules as Record<string, unknown>).generateDenyRule).toBeUndefined();
    expect((accessRules as Record<string, unknown>).generateAccessRulesSection).toBeUndefined();
    expect(accessRules.generateAccessRules).toBeDefined();
  });

  it('does not export acl-generator helpers directly', () => {
    expect((aclGenerator as Record<string, unknown>).generateDomainAcls).toBeUndefined();
    expect((aclGenerator as Record<string, unknown>).generateBlockedDomainAcls).toBeUndefined();
    expect(aclGenerator.generateAclSections).toBeDefined();
  });

  it('does not export generateConfigSections directly', () => {
    expect((configSections as Record<string, unknown>).generateConfigSections).toBeUndefined();
    expect(configSections.buildConfigSections).toBeDefined();
  });
});
