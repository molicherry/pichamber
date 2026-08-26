import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const opencodeSdkClient = fileURLToPath(
  import.meta.resolve("@opencode-ai/sdk/v2/client"),
);

export default defineConfig({
	plugins: [react(), tailwindcss()],
	resolve: {
		alias: {
			"@": path.resolve(dirname, "./src"),
			"@openchamber/ui": path.resolve(dirname, "./src"),
			"@opencode-ai/sdk/v2": opencodeSdkClient,
		},
	},
	worker: {
		format: "es",
	},
	define: {
		"process.env": {},
		global: "globalThis",
	},
	build: {
		chunkSizeWarningLimit: 1200,
		rollupOptions: {
			external: ["node:child_process", "node:fs", "node:path", "node:url"],
		},
	},
	server: {
		proxy: {
			"/session": "http://localhost:8787",
			"/event": "http://localhost:8787",
			"/api": "http://localhost:8787",
		},
	},
});
