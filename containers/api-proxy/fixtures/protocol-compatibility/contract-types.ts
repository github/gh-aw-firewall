import {
  assessFeature, CONTRACTS, DirectedContract, FeatureAssessment,
} from '../../protocol-compatibility';

const contract: DirectedContract = CONTRACTS[0];
const assessment: FeatureAssessment = assessFeature({
  source: 'anthropic_messages', target: 'chat_completions',
  direction: 'request', feature: 'future_feature',
});
const status: 'supported' | 'conditional' | 'rejected' | 'unknown' = assessment.status;
void status;

// @ts-expect-error Evidence is immutable.
contract.features.push(contract.features[0]);
// @ts-expect-error Conditions are immutable.
contract.features[0].conditions.push('anything');
// @ts-expect-error Implementation revision is immutable.
contract.implementation.sha256 = 'anything';
// @ts-expect-error Assessment is not a whole-request success verdict.
assessment.compatible;
// @ts-expect-error Request versus return response is explicit.
assessFeature({ source: 'responses', target: 'chat_completions', direction: 'reverse', feature: 'message_text' });
