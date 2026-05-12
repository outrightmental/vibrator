/**
 * Detection and parsing for GitHub Copilot coding-agent rate-limit
 * messages. Copilot stops work and emits a timeline event whose body
 * starts with "You've hit your rate limit. Please wait for your limit
 * to reset in N minutes…". When that happens vibrator must stop
 * dispatching new work (and especially stop reassigning Copilot to
 * issues) until the window has elapsed — otherwise every iteration
 * spams the repository with requests that are immediately rejected.
 */

/**
 * Matches the rate-limit message Copilot emits when it stops work
 * because the user's premium-request quota is exhausted. The leading
 * phrase is stable; the wait duration is captured for persistence.
 *
 * Example:
 *   "You've hit your rate limit. Please wait for your limit to reset
 *    in 28 minutes or switch to auto model to continue."
 */
const RATE_LIMIT_RESET_PATTERN =
  /hit your rate limit[\s\S]*?reset in\s+(\d+)\s*(second|minute|hour|day)s?/i;

/**
 * Fallback signal for messages that contain the rate-limit phrase but
 * not a parseable duration (e.g. a future template change). When this
 * matches but the more specific pattern does not, callers should still
 * pause — they just use a conservative default reset window.
 */
const RATE_LIMIT_GENERIC_PATTERN = /hit your rate limit/i;

const UNIT_TO_MS: Record<string, number> = {
  second: 1_000,
  minute: 60_000,
  hour: 60 * 60_000,
  day: 24 * 60 * 60_000,
};

export interface RateLimitDetection {
  /** Wall-clock instant when the limit is expected to reset. */
  resetAt: Date;
  /** True if the duration was parsed from the message; false when the
   *  generic fallback was used and a default window was applied. */
  durationWasParsed: boolean;
}

/**
 * Inspect a single message body for a Copilot rate-limit notice and
 * return when the limit is expected to reset, or `null` when the
 * message does not match.
 *
 * @param body         The message body to inspect.
 * @param now          The wall-clock reference for computing resetAt.
 *                     Defaults to `new Date()`; injectable for tests.
 * @param fallbackMs   Default pause window applied when the generic
 *                     rate-limit phrase matches but no duration was
 *                     parsed. Defaults to one hour.
 */
export function detectRateLimitMessage(
  body: string | null | undefined,
  now: Date = new Date(),
  fallbackMs: number = 60 * 60_000,
): RateLimitDetection | null {
  if (!body) {
    return null;
  }

  const specificMatch = RATE_LIMIT_RESET_PATTERN.exec(body);
  if (specificMatch && specificMatch[1] && specificMatch[2]) {
    const amount = Number.parseInt(specificMatch[1], 10);
    const unit = specificMatch[2].toLowerCase();
    const unitMs = UNIT_TO_MS[unit];
    if (Number.isFinite(amount) && unitMs !== undefined) {
      return {
        resetAt: new Date(now.getTime() + amount * unitMs),
        durationWasParsed: true,
      };
    }
  }

  if (RATE_LIMIT_GENERIC_PATTERN.test(body)) {
    return {
      resetAt: new Date(now.getTime() + fallbackMs),
      durationWasParsed: false,
    };
  }

  return null;
}
