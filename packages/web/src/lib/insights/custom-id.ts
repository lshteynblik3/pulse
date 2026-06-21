/**
 * The batch custom_id codec: "<userId>__<localDate>".
 *
 * The submit cron stamps each batch request with a custom_id; the collect cron
 * parses it back to attribute the result to (user, date). Anthropic batch results
 * carry ONLY the custom_id, so per-user attribution depends entirely on this
 * round-trip — hence the dedicated, tested codec.
 *
 * '__' is the separator: UUIDs and YYYY-MM-DD dates contain no underscores, and
 * ':' is disallowed in a custom_id. The date is always the trailing segment, so
 * parse splits on the LAST '__' (robust even if a userId somehow contained one)
 * and validates the date shape — a malformed id returns null so collect can skip
 * and log it rather than mis-attribute.
 */

const SEP = '__';

export function buildCustomId(userId: string, date: string): string {
  return `${userId}${SEP}${date}`;
}

export function parseCustomId(customId: string): { userId: string; date: string } | null {
  const i = customId.lastIndexOf(SEP);
  if (i <= 0) return null; // no separator, or empty userId
  const userId = customId.slice(0, i);
  const date = customId.slice(i + SEP.length);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  return { userId, date };
}
