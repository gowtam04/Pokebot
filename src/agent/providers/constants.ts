/**
 * Shared provider request constants.
 *
 * Kept in its own tiny module so both provider adapters and the runtime can
 * import it without a runtime ⇄ provider import cycle.
 */

/**
 * Output budget per turn. Comfortably fits the largest PokebotAnswer (candidate
 * lists + reasoning). All providers stream, so a non-streaming HTTP timeout does
 * not apply.
 */
export const MAX_TOKENS = 16000;
