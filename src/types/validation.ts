/**
 * Result of validating flag combinations.
 */
export interface FlagValidationResult {
  /** Whether the validation passed */
  valid: boolean;
  /** Error message if validation failed */
  error?: string;
}
