import type { EnvoyController } from "../controller";
import { createSidebarController } from "./sidebar";
import { createEnvoyView } from "./view";

export function mountEnvoyUi(controller: EnvoyController): () => void {
	const view = createEnvoyView(() => sidebar.refresh(), controller);
	const sidebar = createSidebarController(
		view.host,
		view.panel,
		() => view.selectTab(false),
		(available) => controller.setControlsAvailable(available),
	);
	sidebar.update();
	return () => {
		view.destroy();
		sidebar.destroy();
	};
}
