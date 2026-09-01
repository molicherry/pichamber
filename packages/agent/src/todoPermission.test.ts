import { describe, expect, it } from "bun:test";
import { PermissionBroker } from "./permission.js";
import { TodoState } from "./todo.js";

describe("TodoState release contracts", () => {
	it("emits cloned snapshots across add, toggle, restore, and clear", () => {
		const state = new TodoState();
		const snapshots: ReturnType<TodoState["list"]>[] = [];
		const unsubscribe = state.subscribe((todos) => snapshots.push(todos));
		state.add("qualify release", "high");
		state.toggle(0);
		state.setItems([
			{ content: "restored", status: "completed", priority: "low" },
		]);
		const listed = state.list();
		listed[0]!.content = "mutated copy";
		expect(state.list()[0]?.content).toBe("restored");
		state.clear();
		unsubscribe();
		expect(snapshots.map((items) => items.map((item) => item.status))).toEqual([
			["pending"],
			["in_progress"],
			["completed"],
			[],
		]);
	});
});

describe("PermissionBroker release contracts", () => {
	it("resolves confirm, select, and input prompts and rejects unknown replies", async () => {
		const broker = new PermissionBroker();
		const prompts: Array<{ id: string; kind: string }> = [];
		broker.subscribe((prompt) =>
			prompts.push({ id: prompt.id, kind: prompt.kind }),
		);

		const confirm = broker.request({
			sessionId: "s",
			kind: "confirm",
			title: "Allow?",
		});
		expect(broker.respond(prompts.at(-1)!.id, true)).toBe(true);
		expect(await confirm).toBe(true);

		const select = broker.request({
			sessionId: "s",
			kind: "select",
			title: "Choose",
			options: ["Yes", "No"],
		});
		expect(broker.respond(prompts.at(-1)!.id, false)).toBe(true);
		expect(await select).toBe("No");

		const input = broker.request({
			sessionId: "s",
			kind: "input",
			title: "Question",
		});
		expect(broker.respond(prompts.at(-1)!.id, true, "answer")).toBe(true);
		expect(await input).toBe("answer");
		expect(broker.respond("missing", true)).toBe(false);
	});
});
