/**
 * Re-export the opencode types we consume, so the adapter and (later) the
 * vendored openchamber UI share the exact same shapes. Type-only: no runtime
 * import of @opencode-ai/sdk is allowed in this package.
 */

export type {
  Session,
  Message,
  UserMessage,
  AssistantMessage,
  TextPart,
  ReasoningPart,
  ToolPart,
  ToolState,
  ToolStateRunning,
  ToolStateCompleted,
  ToolStateError,
  StepStartPart,
  StepFinishPart,
  PatchPart,
  Part,
} from "@opencode-ai/sdk/v2/types";
