/**
 * model-list adapter — reads pi's configured providers/models and reshapes them
 * into the opencode `Provider`/`Model` shape the UI's model picker expects.
 * API keys are never exposed — only id/name/metadata are returned.
 */

import { ModelRuntime, getAgentDir } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import path from "node:path";

interface PiModel {
	id: string;
	name?: string;
	reasoning?: boolean;
	contextWindow?: number;
	maxTokens?: number;
	input?: unknown;
}

interface PiProvider {
	id: string;
	name?: string;
}

export interface OpenCodeModelList {
	providers: Array<{
		id: string;
		name: string;
		source: "config";
		env: string[];
		options: Record<string, unknown>;
		models: Record<string, Record<string, unknown>>;
	}>;
	default: Record<string, string>;
}

/** Provider ids the user actually configured in models.json. */
function readConfiguredProviderIds(): Set<string> {
	try {
		const raw = fs.readFileSync(path.join(getAgentDir(), "models.json"), "utf8");
		const parsed: unknown = JSON.parse(raw);
		const providers =
			parsed && typeof parsed === "object" && !Array.isArray(parsed)
				? (parsed as Record<string, unknown>).providers
				: undefined;
		if (providers && typeof providers === "object" && !Array.isArray(providers)) {
			return new Set(Object.keys(providers as Record<string, unknown>));
		}
	} catch {
		// unreadable/absent models.json → no configured providers
	}
	return new Set();
}

export async function listModelProviders(): Promise<OpenCodeModelList> {
	const runtime = await ModelRuntime.create();
	const configuredIds = readConfiguredProviderIds();
	// Only list providers the user actually configured — pi's getProviders()
	// also returns its built-in catalog (40+ providers), which would show
	// unusable ghosts in the model picker.
	const providers = (runtime.getProviders() as unknown as PiProvider[]).filter(
		(p) => configuredIds.has(p.id),
	);
	const providersOut: OpenCodeModelList["providers"] = [];
	const defaults: Record<string, string> = {};

	for (const provider of providers) {
		const models = runtime.getModels(provider.id) as unknown as PiModel[];
		const modelMap: Record<string, Record<string, unknown>> = {};

		for (const model of models) {
			const context =
				typeof model.contextWindow === "number" ? model.contextWindow : 200_000;
			const output =
				typeof model.maxTokens === "number" ? model.maxTokens : 16_384;
			const reasoning = model.reasoning === true;
			const acceptsImages =
				Array.isArray(model.input) && model.input.includes("image");

			modelMap[model.id] = {
				id: model.id,
				providerID: provider.id,
				api: { id: "", url: "", npm: "" },
				name: model.name ?? model.id,
				capabilities: {
					temperature: true,
					reasoning,
					attachment: false,
					toolcall: true,
					input: {
						text: true,
						audio: false,
						image: acceptsImages,
						video: false,
						pdf: false,
					},
					output: {
						text: true,
						audio: false,
						image: false,
						video: false,
						pdf: false,
					},
					interleaved: reasoning ? { field: "reasoning_content" } : false,
				},
				cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
				limit: { context, output },
				status: "active",
				options: {},
				headers: {},
				release_date: "2024-01-01",
			};
		}

		if (Object.keys(modelMap).length > 0) {
			providersOut.push({
				id: provider.id,
				name: provider.name ?? provider.id,
				source: "config",
				env: [],
				options: {},
				models: modelMap,
			});
			defaults[provider.id] = models[0]?.id ?? "";
		}
	}

	return { providers: providersOut, default: defaults };
}
