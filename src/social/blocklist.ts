/**
 * Plaza content moderation blocklist.
 * Filters common profanity, offensive slurs (English + Filipino),
 * and URLs (http:// or https://) to keep comments friendly and link-free.
 */

const BLOCKED_PATTERNS: RegExp[] = [
  // Links
  /https?:\/\//i,
  /www\.[a-z0-9\-]+\.[a-z]{2,}/i,
  // Profanity & offensive terms (English)
  /\b(?:fuck|shit|bitch|asshole|bastard|cunt|dick|pussy)\b/i,
  // Profanity & offensive terms (Filipino)
  /\b(?:tangina|putangina|gago|gaga|tarantado|tarantada|ulol|bobo|pokpok|kupal|hudas|leche|buwisit)\b/i,
];

/**
 * Checks if a comment contains blocked words, slurs, or hyperlinks.
 */
export function isCommentBlocked(text: string): boolean {
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(text)) {
      return true;
    }
  }
  return false;
}
