/**
 * todo tool + per-session todo state, mapped to opencode's Todo model.
 * pi has no built-in session todo tool, so this is a custom ToolDefinition.
 */

import {
	Object,
	String as TString,
	Integer,
	Optional,
	Union,
	Literal,
} from "typebox";
import type { Static } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

/** Mirrors opencode's `Todo` type (content/status/priority). */
export interface TodoItem {
	content: string;
	status: string;
	priority: string;
}

const TODO_STATUS_ORDER = ["pending", "in_progress", "completed"] as const;

export class TodoState {
	private items: TodoItem[] = [];
	private readonly listeners = new Set<(todos: TodoItem[]) => void>();

	list(): TodoItem[] {
		return this.items.map((t) => ({ ...t }));
	}

	/** Replace the whole list (used to restore persisted todos); emits a change. */
	setItems(items: TodoItem[]): void {
		this.items = items.map((t) => ({
			content: t.content,
			status: t.status,
			priority: t.priority,
		}));
		this.emit();
	}

	subscribe(listener: (todos: TodoItem[]) => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	private emit(): void {
		const snapshot = this.list();
		for (const l of this.listeners) l(snapshot);
	}

	add(content: string, priority = "medium"): TodoItem {
		const item: TodoItem = { content, status: "pending", priority };
		this.items.push(item);
		this.emit();
		return item;
	}

	toggle(index: number): TodoItem | null {
		const item = this.items[index];
		if (!item) return null;
		const i = TODO_STATUS_ORDER.indexOf(
			item.status as (typeof TODO_STATUS_ORDER)[number],
		);
		item.status =
			TODO_STATUS_ORDER[(i + 1) % TODO_STATUS_ORDER.length] ?? "pending";
		this.emit();
		return item;
	}

	clear(): void {
		this.items = [];
		this.emit();
	}
}

const todoSchema = Object({
	action: Union([
		Literal("list"),
		Literal("add"),
		Literal("toggle"),
		Literal("clear"),
	]),
	text: Optional(TString()),
	index: Optional(Integer()),
});

type TodoParams = Static<typeof todoSchema>;

function render(items: TodoItem[]): string {
	if (items.length === 0) return "No todos.";
	return items.map((t, i) => `${i}. [${t.status}] ${t.content}`).join("\n");
}

export function createTodoTool(
	state: TodoState,
): ToolDefinition<typeof todoSchema> {
	return {
		name: "todo",
		label: "Todo",
		description:
			"Manage the session's task list. Actions: list (show all), add (append a task, requires text), toggle (advance a task's status, requires index), clear (remove all).",
		promptSnippet: "Manage a persistent task list",
		parameters: todoSchema,
		async execute(_toolCallId, params: TodoParams) {
			let text: string;
			switch (params.action) {
				case "list":
					text = render(state.list());
					break;
				case "add": {
					const content = (params.text ?? "").trim();
					if (!content) {
						text = "Error: text is required for add.";
						break;
					}
					state.add(content);
					text = `Added todo: ${content}`;
					break;
				}
				case "toggle": {
					const index = params.index ?? -1;
					const items = state.list();
					if (index < 0 || index >= items.length) {
						text = `Error: index ${index} out of range (0-${items.length - 1}).`;
						break;
					}
					const toggled = state.toggle(index);
					text = `Toggled todo ${index}: ${toggled?.content ?? ""}`;
					break;
				}
				case "clear":
					state.clear();
					text = "Cleared all todos.";
					break;
				default:
					text = `Unknown action: ${String(params.action)}`;
			}
			return { content: [{ type: "text", text }], details: {} };
		},
	};
}
