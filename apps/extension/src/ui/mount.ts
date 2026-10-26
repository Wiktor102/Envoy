import { createSidebarController } from "./sidebar";
import { createEnvoyView } from "./view";

export function mountEnvoyUi(): () => void {
	const view = createEnvoyView(() => sidebar.refresh());
	const sidebar = createSidebarController(view.host, view.panel, () => view.selectTab(false));
	sidebar.update();
	return () => sidebar.destroy();
}
