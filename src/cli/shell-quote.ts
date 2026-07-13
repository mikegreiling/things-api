/**
 * Shell-safe rendering of a single argument for a reconstructed `things …`
 * command string (truncation footers, the normalized-form echo, the
 * did-you-mean suggestion). A plain word is left bare; anything with spaces or
 * shell metacharacters is double-quoted with the hazardous characters escaped.
 * Lives in its own leaf module so both the read driver and the argv resolver
 * can share ONE quoting rule (they must agree — the echo is contract-tested).
 */
export function shellQuote(v: string): string {
  return /^[\w./@:+-]+$/.test(v) ? v : `"${v.replace(/(["\\$`])/g, "\\$1")}"`;
}
