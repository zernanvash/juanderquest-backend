// Shared blocklist patterns for Plaza comments, destination fields, and user-submitted text.
// Synchronous regex-only check (zero external calls).

const BLOCKED_PATTERNS: RegExp[] = [
  /https?:\/\//i,
  /www\.[a-z0-9-]+\.[a-z]{2,}/i,
  /\b(?:fuck|shit|bitch|asshole|bastard|cunt|dick|pussy)\b/i,
  /\b(?:tangina|putangina|gago|gaga|tarantado|tarantada|ulol|bobo|pokpok|kupal|hudas|leche|buwisit)\b/i,
];

/**
 * Returns true if text contains external links or profanity/slur terms.
 */
export function textBlocked(text: string): boolean {
  if (!text) return false;
  return BLOCKED_PATTERNS.some((pattern) => pattern.test(text));
}

export function isCommentBlocked(text: string): boolean {
  return textBlocked(text);
}
