/**
 * Normalized agent events — the only event shapes the upper layer sees.
 * Self-contained: this file must never import the pi SDK.
 *
 * v2 additions (additive members): tool input/output/details, turn usage.
 */

export interface AgentUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  /** Reasoning/thinking tokens (subset of output) when the provider reports them. */
  reasoning: number;
  /** Turn cost in USD. */
  cost: number;
}

export type AgentEvent =
  | { type: "text_delta"; delta: string }
  | { type: "thinking_delta"; delta: string }
  | { type: "tool_start"; toolCallId: string; toolName: string; args: Record<string, unknown> }
  | {
      type: "tool_end";
      toolCallId: string;
      toolName: string;
      output: string;
      details: Record<string, unknown>;
      isError: boolean;
    }
  | { type: "tool_update"; toolCallId: string; toolName: string; partial: string }
  | { type: "message_start"; messageId?: string }
  | { type: "message_end"; messageId?: string }
  | { type: "agent_start" }
  | { type: "agent_end"; error?: string }
  | { type: "turn_start" }
  | { type: "turn_end"; usage: AgentUsage }
  | { type: "queue_update"; steering?: string; followUp?: string }
  | { type: "bash_output"; delta: string }
  | { type: "status"; status: "idle" | "streaming" | "aborted" | "error"; error?: string };
