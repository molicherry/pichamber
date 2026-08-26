/**
 * permission bridge — injects a web-backed ExtensionUIContext into a pi session
 * so the built-in permission extensions (permission-gate, protected-paths, …)
 * can actually ask the user via the browser instead of silently blocking.
 */

import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionUIContext, InlineExtension } from "@earendil-works/pi-coding-agent";

export interface PermissionPrompt {
	id: string;
	sessionId: string;
	kind: "confirm" | "select" | "input";
	title: string;
	message?: string;
	options?: string[];
	placeholder?: string;
}

type PromptResult = boolean | string | undefined;

type PendingPrompt = {
	resolve: (result: PromptResult) => void;
	prompt: PermissionPrompt;
};

export class PermissionBroker {
	private readonly pending = new Map<string, PendingPrompt>();
	private readonly listeners = new Set<(prompt: PermissionPrompt) => void>();

	request(prompt: Omit<PermissionPrompt, "id">): Promise<PromptResult> {
		const id = randomUUID();
		const full: PermissionPrompt = { ...prompt, id };
		return new Promise<PromptResult>((resolve) => {
			this.pending.set(id, { resolve, prompt: full });
			for (const l of this.listeners) l(full);
		});
	}

	subscribe(listener: (prompt: PermissionPrompt) => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	/**
	 * Resolve a pending prompt. `allowed` is the user's yes/no decision;
	 * `value` is an optional free-form value (for `input` prompts).
	 */
	respond(id: string, allowed: boolean, value?: string): boolean {
		const pending = this.pending.get(id);
		if (!pending) return false;
		this.pending.delete(id);
		const { prompt } = pending;
		let result: PromptResult;
		if (prompt.kind === "confirm") {
			result = allowed;
		} else if (prompt.kind === "select") {
			// Return the option the user actually picked (first option = allow,
			// second = the reject choice when present).
			result = allowed ? (prompt.options?.[0]) : (prompt.options?.[1] ?? undefined);
		} else {
			result = allowed ? (value ?? "") : undefined;
		}
		pending.resolve(result);
		return true;
	}
}

const noop = (): void => {};

/**
 * Build an ExtensionUIContext whose confirm/select/input are bridged to the web
 * layer through the broker. Everything else is a no-op (we have no TUI).
 */
export function createWebUIContext(
	broker: PermissionBroker,
	sessionId: string,
): ExtensionUIContext {
	return {
		select: (title, options) =>
			broker.request({ sessionId, kind: "select", title, options }) as Promise<string | undefined>,
		confirm: (title, message) =>
			broker.request({
				sessionId,
				kind: "confirm",
				title,
				message,
			}) as Promise<boolean>,
		input: (title, placeholder) =>
			broker.request({
				sessionId,
				kind: "input",
				title,
				placeholder,
			}) as Promise<string | undefined>,
		notify: noop,
		onTerminalInput: () => noop,
		setStatus: noop,
		setWorkingMessage: noop,
		setWorkingVisible: noop,
		setWorkingIndicator: noop,
		setHiddenThinkingLabel: noop,
		setWidget: noop,
		setFooter: noop,
		setHeader: noop,
		setTitle: noop,
		custom: (async () => undefined) as ExtensionUIContext["custom"],
		pasteToEditor: noop,
		setEditorText: noop,
		getEditorText: () => "",
		editor: async () => undefined,
		addAutocompleteProvider: noop,
		setEditorComponent: noop,
		getEditorComponent: () => undefined,
		theme: undefined as unknown as ExtensionUIContext["theme"],
		getAllThemes: () => [],
		getTheme: () => undefined,
		setTheme: () => ({ success: false }),
	getToolsExpanded: () => false,
	setToolsExpanded: noop,
};
}

/**
 * Inline extension that gates file-mutating tools (write/edit) behind a
 * runtime confirmation, mirroring the built-in permission-gate for dangerous
 * bash. Registered via DefaultResourceLoader.extensionFactories so it runs in
 * every session without touching ~/.pi/agent/extensions.
 */
export function createWriteGateExtension(): InlineExtension {
	return {
		name: "pichamber-write-gate",
		hidden: true,
		factory: (pi: ExtensionAPI) => {
			pi.on("tool_call", async (event, ctx) => {
				if (event.toolName !== "write" && event.toolName !== "edit") return undefined;
				if (!ctx.hasUI) return undefined; // no UI: don't block silently
				const choice = await ctx.ui.select(`Allow ${event.toolName}?`, ["Yes", "No"]);
				if (choice !== "Yes") return { block: true, reason: "Blocked by user" };
				return undefined;
			});
		},
	};
}
