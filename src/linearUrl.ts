const IDENTIFIER_PATTERN = /^[A-Z]+-\d+$/;

export function linearIssueUrl(identifier: string, orgSlug = "anmho"): string | null {
  if (!IDENTIFIER_PATTERN.test(identifier)) {
    return null;
  }
  const slug = orgSlug.trim().replace(/^\/+|\/+$/g, "");
  if (!slug) {
    return null;
  }
  return `https://linear.app/${slug}/issue/${identifier}`;
}
