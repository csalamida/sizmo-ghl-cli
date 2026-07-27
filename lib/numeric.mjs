// lib/numeric.mjs — parse a user-supplied numeric flag, or refuse it.
//
// WHY THIS MODULE EXISTS
// `Number('abc')` is NaN, and `JSON.stringify({ x: NaN })` is `{"x":null}`. So a command that does
//     ...(args.value != null ? { monetaryValue: Number(args.value) } : {})
// transmits `null` on a typo — and on an UPDATE verb, null BLANKS the stored value. The user is
// shown a confirm preview echoing their typo back as though it were understood, approves it, and
// the field is wiped. Found 2026-07-27 on `opp update --value abc`, then found again by a
// source-level guard in `field.mjs` (--position, --max-files) and `calendar.mjs` (--slot-min).
//
// This is the coercion sibling of the standing rule "unset flags must be OMITTED, never sent as
// null." That rule covered flags the user never passed. This covers the same blanking outcome
// reached through a flag the user DID pass, badly.
//
// Lives in lib/ because three separate commands need it. Four bugs earlier in this session came
// from one fact living in two places; a fourth copy of this parser would have been the fifth.
import { GhlError, EXIT } from './errors.mjs';

/**
 * Parse a numeric CLI flag, throwing EXIT.USAGE rather than letting NaN reach a request body.
 *
 * Call this BEFORE building the confirm preview. Validating inside the body literal means the
 * error fires after the user has already read and approved a preview containing their bad input.
 *
 * @param {unknown} raw    the flag value as the arg parser produced it (usually a string)
 * @param {object}  opts
 * @param {string}  opts.flag     flag name for the message, e.g. '--value'
 * @param {string}  opts.context  command context, e.g. 'opp update'
 * @param {boolean} [opts.integer=false]  require a whole number
 * @param {number}  [opts.min=0]          minimum allowed value, inclusive
 * @param {string}  [opts.example]        a valid example to show the user
 * @returns {number}
 */
export function parseNumericFlag(raw, { flag, context, integer = false, min = 0, example } = {}) {
  const n = Number(raw);
  const bad =
    !Number.isFinite(n) ||          // NaN and ±Infinity both serialize badly
    n < min ||
    (integer && !Number.isInteger(n));

  if (bad) {
    const wants = [
      integer ? 'a whole number' : 'a number',
      min === 0 ? '>= 0' : `>= ${min}`,
    ].join(' ');
    throw new GhlError(
      `${context}: invalid ${flag} '${raw}' — expected ${wants}${example ? ` (e.g. ${example})` : ''}`,
      EXIT.USAGE,
      'an unparseable number is transmitted as null, which blanks the stored value',
    );
  }
  return n;
}
