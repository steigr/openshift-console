// Minimal Punycode (RFC 3492) ACE decoder - just enough to turn an
// "xn--..." IDN label back into its Unicode form for display. Written
// directly from the RFC's Bootstring algorithm rather than pulling in a
// dependency for one small, stable, public algorithm.

const BASE = 36;
const T_MIN = 1;
const T_MAX = 26;
const SKEW = 38;
const DAMP = 700;
const INITIAL_BIAS = 72;
const INITIAL_N = 128;
const DELIMITER = '-';

const adapt = (delta: number, numPoints: number, firstTime: boolean): number => {
  let d = firstTime ? Math.floor(delta / DAMP) : delta >> 1;
  d += Math.floor(d / numPoints);
  let k = 0;
  while (d > ((BASE - T_MIN) * T_MAX) >> 1) {
    d = Math.floor(d / (BASE - T_MIN));
    k += BASE;
  }
  return Math.floor(k + ((BASE - T_MIN + 1) * d) / (d + SKEW));
};

// '0'-'9' -> 26-35, 'A'-'Z'/'a'-'z' -> 0-25; anything else is invalid (>= BASE).
const basicToDigit = (codePoint: number): number => {
  if (codePoint >= 0x30 && codePoint < 0x3a) return codePoint - 0x16;
  if (codePoint >= 0x41 && codePoint < 0x5b) return codePoint - 0x41;
  if (codePoint >= 0x61 && codePoint < 0x7b) return codePoint - 0x61;
  return BASE;
};

// Decodes a single ACE label's payload (the part after the "xn--" prefix).
const decodeACE = (input: string): string => {
  const output: number[] = [];
  let n = INITIAL_N;
  let i = 0;
  let bias = INITIAL_BIAS;

  let basicLength = input.lastIndexOf(DELIMITER);
  if (basicLength < 0) {
    basicLength = 0;
  }
  for (let j = 0; j < basicLength; j++) {
    output.push(input.charCodeAt(j));
  }

  let index = basicLength > 0 ? basicLength + 1 : 0;
  const inputLength = input.length;

  while (index < inputLength) {
    const oldi = i;
    let w = 1;
    for (let k = BASE; ; k += BASE) {
      if (index >= inputLength) {
        throw new Error('invalid punycode: truncated');
      }
      const digit = basicToDigit(input.charCodeAt(index++));
      if (digit >= BASE) {
        throw new Error('invalid punycode: bad digit');
      }
      i += digit * w;
      const t = k <= bias ? T_MIN : k >= bias + T_MAX ? T_MAX : k - bias;
      if (digit < t) {
        break;
      }
      w *= BASE - t;
    }
    const outLength = output.length + 1;
    bias = adapt(i - oldi, outLength, oldi === 0);
    n += Math.floor(i / outLength);
    i %= outLength;
    output.splice(i, 0, n);
    i++;
  }

  return String.fromCodePoint(...output);
};

// Decodes one "xn--..." DNS label to Unicode, or returns it unchanged if
// it isn't an ACE label or fails to decode (a malformed label shouldn't
// crash the details page - just show it as-is).
const decodeLabel = (label: string): string => {
  if (!label.toLowerCase().startsWith('xn--')) {
    return label;
  }
  try {
    return decodeACE(label.slice(4));
  } catch {
    return label;
  }
};

// Decodes every "xn--..." label in a dotted hostname (leaves a leading
// "*" wildcard label untouched, since it's never ACE-encoded).
export const decodeIDN = (hostname: string): string => hostname.split('.').map(decodeLabel).join('.');
