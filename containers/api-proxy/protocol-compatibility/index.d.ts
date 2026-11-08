export type Protocol = 'chat_completions' | 'responses' | 'anthropic_messages';
export type TranslationDirection = 'request' | 'return_response';
export type CompatibilityStatus = 'supported' | 'conditional' | 'rejected' | 'unknown';
export type Feature =
  | 'message_text' | 'message_roles' | 'function_tools' | 'hosted_tools' | 'tool_choice'
  | 'parallel_tool_calls' | 'structured_output' | 'image_input' | 'audio'
  | 'other_modalities' | 'streaming' | 'usage' | 'stateful_fields' | 'reasoning_fields'
  | 'reasoning_content' | 'cache_controls' | 'token_limits' | 'transport_fields'
  | 'finish_reasons' | 'refusal' | 'unknown_fields';

export interface FeatureEvidence {
  readonly feature: Feature;
  readonly status: CompatibilityStatus;
  readonly conditions: readonly string[];
  readonly normalizations: readonly string[];
  readonly reason: string;
  readonly rejectionCode?: 'unsupported_wire_api_feature' | 'unsupported_protocol_feature';
}

export interface DirectedContract {
  readonly id: string;
  readonly source: Protocol;
  readonly target: Protocol;
  readonly direction: TranslationDirection;
  readonly revision: string;
  readonly implementation: Readonly<{ file: string; sha256: string }>;
  readonly entryPoints: readonly string[];
  readonly features: readonly FeatureEvidence[];
}

export interface FeatureAssessment {
  readonly revision: string;
  readonly status: CompatibilityStatus;
  readonly reason: string;
  readonly contract: DirectedContract | null;
  readonly evidence: FeatureEvidence | null;
}

export const REVISION: string;
export const FEATURES: readonly Feature[];
export const CONTRACTS: readonly DirectedContract[];
/** Bounded feature evidence only. No request validation, routing or model discovery. */
export function assessFeature(query?: Readonly<{
  source: Protocol;
  target: Protocol;
  direction: TranslationDirection;
  feature: string;
}>): FeatureAssessment;
