import {
	createConfiguredWebAPIs,
	getDesktopRelayRestoreReady,
} from "./runtimeConfig";

import type { RuntimeAPIs } from "@openchamber/ui/lib/api/types";
import {
	resolveHostedSurface,
	watchHostedSurfaceViewport,
	type HostedSurface,
} from "@openchamber/ui/lib/runtimeSurface";
import {
	isEmbeddedSessionChat,
	requestEmbeddedSessionRuntimeBootstrap,
} from "@openchamber/ui/components/layout/contextPanelEmbeddedChat";
import "@openchamber/ui/index.css";
import "@openchamber/ui/styles/fonts";

declare global {
	interface Window {
		__OPENCHAMBER_RUNTIME_APIS__?: RuntimeAPIs;
		__OPENCHAMBER_SURFACE__?: HostedSurface;
	}
}

const hostedSurface: HostedSurface = resolveHostedSurface();

const start = async (): Promise<void> => {
	const embeddedBootstrap = isEmbeddedSessionChat()
		? await requestEmbeddedSessionRuntimeBootstrap()
		: null;
	window.__OPENCHAMBER_RUNTIME_APIS__ =
		createConfiguredWebAPIs(embeddedBootstrap);

	// Reload into the other app shell when the viewport crosses the phone
	// threshold after boot (no-op in fixed shells and with ?surface= overrides).
	watchHostedSurfaceViewport();

	if (hostedSurface === "mobile") {
		const { renderMobileApp } = await import(
			"@openchamber/ui/apps/renderMobileApp"
		);
		renderMobileApp(window.__OPENCHAMBER_RUNTIME_APIS__);
		return;
	}

	// Hold the render until a desktop relay-host restore has picked its transport.
	await getDesktopRelayRestoreReady();
	await import("@openchamber/ui/main");
};

void start();

if (import.meta.hot) {
	import.meta.hot.on("openchamber:theme-updated", (theme: unknown) => {
		window.dispatchEvent(
			new CustomEvent("openchamber:theme-hmr", { detail: theme }),
		);
	});
}
