export interface TransformResult {
  content: string;
  messages: string[];
}

export interface PatchContext {
  workflowPath: string;
  workflowFile: string | undefined;
}

export type WorkflowTransform = (content: string, context: PatchContext) => TransformResult;
