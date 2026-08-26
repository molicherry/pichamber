/**
 * @pichamber/agent — public entry point.
 * Exports the stable contracts and the pi adapter factory. Nothing else.
 */

export type {
	AgentClient,
	ImageContent,
	PromptOpts,
} from "./contracts/client.js";
export type { AgentEvent } from "./contracts/events.js";
export type { AgentMessage, AgentSnapshot } from "./contracts/snapshot.js";
export { createAgentClient } from "./pi/PiAgentClient.js";
export type { AgentClientConfig } from "./pi/PiAgentClient.js";

export { SessionRegistry } from "./sessionRegistry.js";
export type {
  SessionHandle,
  SessionRuntime,
  SessionRegistryOptions,
} from "./sessionRegistry.js";

export { SessionStore } from "./opencode/SessionStore.js";
export type { SessionStoreOptions, StoreChange } from "./opencode/SessionStore.js";
export { TodoState, createTodoTool } from "./todo.js";
export type { TodoItem } from "./todo.js";
export { createSubtaskTool } from "./subtask.js";
export type { SubtaskOptions } from "./subtask.js";
export { listModelProviders } from "./models.js";
export { PermissionBroker, createWebUIContext } from "./permission.js";
export type { PermissionPrompt } from "./permission.js";
export type {
	Session,
	Message,
	UserMessage,
	AssistantMessage,
	TextPart,
	ReasoningPart,
	ToolPart,
	ToolState,
	Part,
} from "./opencode/types.js";
