/**
 * pi runtime dependency detection.
 *
 * pichamber's agent depends on pi's agent-dir (~/.pi/agent or PI_CODING_AGENT_DIR)
 * for: npm plugins (pi-lens = lsp, pi-mcp-adapter = mcp), extensions
 * (permission-gate / protected-paths / bash-safety), and models.json (providers).
 * Missing pieces silently degrade — this module surfaces them so startup logs
 * and /api/health can warn instead of failing mysteriously.
 */
import fs from "node:fs";
import path from "node:path";

export interface PiRuntimeStatus {
	agentDir: string;
	plugins: Record<string, boolean>;
	extensions: Record<string, boolean>;
	models: boolean;
	missing: string[];
	ok: boolean;
}

const REQUIRED_PLUGINS = ["pi-lens", "pi-mcp-adapter"];
const REQUIRED_EXTENSIONS = [
	"permission-gate",
	"protected-paths",
	"bash-safety",
];

/** Resolve pi's agent dir the same way pi's getAgentDir() does. */
export function resolveAgentDir(): string {
	return (
		process.env.PI_CODING_AGENT_DIR ??
		path.join(process.env.HOME ?? "/root", ".pi", "agent")
	);
}

export function detectPiRuntime(): PiRuntimeStatus {
	const agentDir = resolveAgentDir();
	const npmDir = path.join(agentDir, "npm", "node_modules");
	const extDir = path.join(agentDir, "extensions");
	const modelsPath = path.join(agentDir, "models.json");

	const plugins: Record<string, boolean> = {};
	for (const name of REQUIRED_PLUGINS) {
		plugins[name] = fs.existsSync(path.join(npmDir, name));
	}
	const extensions: Record<string, boolean> = {};
	for (const name of REQUIRED_EXTENSIONS) {
		extensions[name] = fs.existsSync(path.join(extDir, `${name}.ts`));
	}
	const models = fs.existsSync(modelsPath);

	const missing: string[] = [];
	for (const [name, present] of Object.entries(plugins)) {
		if (!present) missing.push(`plugin:${name}`);
	}
	for (const [name, present] of Object.entries(extensions)) {
		if (!present) missing.push(`extension:${name}`);
	}
	if (!models) missing.push("models.json");

	return {
		agentDir,
		plugins,
		extensions,
		models,
		missing,
		ok: missing.length === 0,
	};
}

/** Human-readable install hint for anything missing (for startup logs). */
export function formatPiRuntimeWarning(status: PiRuntimeStatus): string | null {
	if (status.ok) return null;
	const lines = [
		`pi runtime incomplete (agentDir=${status.agentDir}):`,
		...status.missing.map((m) => `  - missing ${m}`),
		"Install hints:",
		"  npm plugins:  cd <agentDir>/npm && npm install pi-lens pi-mcp-adapter",
		"  extensions:   copy permission-gate.ts / protected-paths.ts / bash-safety.ts into <agentDir>/extensions/",
		"  models.json:  mount/provide your models.json (holds provider API keys)",
	];
	return lines.join("\n");
}
