// Bump the version whenever terms.html changes so every user accepts it again.
export const TERMS_VERSION = "2026-11-01";
export const TERMS_STORAGE_KEY = "envoyTermsAcceptance";

export type TermsAcceptance = { version: string; acceptedAt: string };

export function hasAcceptedTerms(saved: unknown): boolean {
	if (typeof saved !== "object" || saved === null) return false;
	const { version, acceptedAt } = saved as Partial<TermsAcceptance>;
	return version === TERMS_VERSION && typeof acceptedAt === "string";
}
