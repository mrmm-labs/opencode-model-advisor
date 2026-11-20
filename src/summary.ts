/** Things that look like credentials; each match is replaced before anything is stored. */
const SECRETS: RegExp[] = [
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr|github_pat|glpat|xox[abprs])[-_A-Za-z0-9]{8,}/g,
  /\bAKIA[0-9A-Z]{12,}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\.?[A-Za-z0-9_-]*/g,
  /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b[\w.-]*(?:key|token|secret|passw(?:or)?d|pwd|credential)[\w.-]*\s*[:=]\s*\S+/gi,
  /\b[A-Za-z0-9+/_-]{32,}={0,2}/g,
]

export const redact = (text: string): string =>
  SECRETS.reduce((t, re) => t.replace(re, "[secret]"), text)

/**
 * One line of at most `max` characters saying what a dispatch is about, for the
 * alert toast: markers and secrets removed, whitespace collapsed.
 */
export function summarize(text: string | undefined, max = 80): string {
  const line = redact(
    (text ?? "").replace(/\[\[[^\]]*\]\]/g, " ").replace(/\s+/g, " "),
  ).trim()
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line
}
