// Callers log errors. A control character or a line or paragraph separator in a message
// would start a new log line, and a format character, such as a right-to-left override
// (U+202E) or a zero width space (U+200B), or an unpaired surrogate would change how the
// line reads or hide part of it. These functions keep text the client did not write on one
// line and readable.
const UNPRINTABLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]+/gu;

/** The text on one line, with each run of those characters replaced with a space. */
export function spaced(text: string): string {
  return text.replace(UNPRINTABLE, " ").trim();
}

/**
 * The text on one line, with each of those characters written as \uXXXX escapes, one for
 * each UTF-16 code unit, as JSON writes them.
 */
export function escaped(text: string): string {
  return text.replace(UNPRINTABLE, (run) => {
    let escapes = "";
    for (let index = 0; index < run.length; index += 1) {
      escapes += `\\u${run.charCodeAt(index).toString(16).padStart(4, "0")}`;
    }
    return escapes;
  });
}

/** The text cut to at most maxLength characters, with "..." where it was cut, never inside a character. */
export function cut(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  // A character such as an emoji takes two UTF-16 code units. Cutting between them would
  // leave half a character.
  const end = isHighSurrogate(text.charCodeAt(maxLength - 1)) ? maxLength - 1 : maxLength;
  return `${text.slice(0, end)}...`;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}
