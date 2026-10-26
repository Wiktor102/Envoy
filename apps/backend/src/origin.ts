// Browsers always send Origin on WebSockets; do not let ordinary websites
// connect to the local backend. Local non-browser clients can omit Origin.
export function allowedOrigin(origin: string | undefined): boolean {
	return !origin || /^chrome-extension:\/\/[a-p]{32}$/.test(origin);
}
