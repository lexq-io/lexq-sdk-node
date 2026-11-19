// The grammar of a JSON number (RFC 8259, section 6).
const JSON_NUMBER = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/;

// JSON.rawJSON is in Node.js 21 and later, but not yet in TypeScript's lib.
const json = JSON as JSON & { rawJSON(text: string): unknown };

/**
 * A number with every digit kept.
 *
 * LexQ calculates in decimal, and an amount can carry 34 significant digits or more,
 * while a JavaScript number holds about 15. Every number in a decision's facts, contexts,
 * and traces comes back as a `Decimal`, and a `Decimal` you send goes out with the same
 * digits.
 *
 * Read it with `toString()`, for example to hand it to a decimal library, or with
 * `toNumber()` when the nearest JavaScript number is enough. Arithmetic and comparison
 * operators throw on a `Decimal`, so no digit is lost without a call that asks for it.
 *
 * @example
 * new Decimal("150000.50");
 * new Decimal(150000);
 * new Decimal(150000n);
 */
export class Decimal {
  /** The number as JSON text, exactly as written, for example `"33.33333333333333333333333333333333"` or `"1E-7"`. */
  readonly text: string;

  /**
   * @param value A JSON number as text, a finite number, or a bigint.
   * @throws {TypeError} When the text is not a JSON number or the number is not finite.
   */
  constructor(value: string | number | bigint) {
    if (typeof value === "string") {
      if (!JSON_NUMBER.test(value)) {
        throw new TypeError("Decimal needs a JSON number, such as 150000.50 or -1.5E+3");
      }
      this.text = value;
    } else if (typeof value === "number") {
      if (!Number.isFinite(value)) {
        throw new TypeError("Decimal needs a finite number");
      }
      this.text = String(value);
    } else if (typeof value === "bigint") {
      this.text = value.toString();
    } else {
      throw new TypeError("Decimal takes a string, a number, or a bigint");
    }
    Object.freeze(this);
  }

  /** The number as JSON text, the same as `text`. */
  toString(): string {
    return this.text;
  }

  /** The nearest JavaScript number. Digits past about 15 are lost, and a value too large for a number becomes `Infinity`. */
  toNumber(): number {
    return Number(this.text);
  }

  /** Lets `JSON.stringify` write the number with every digit. */
  toJSON(): unknown {
    return json.rawJSON(this.text);
  }

  /**
   * Always throws, so that `decimal + 1` or `decimal > 100` fails instead of losing digits.
   * Call `toNumber()` or `toString()` instead.
   */
  valueOf(): never {
    throw new TypeError("A Decimal has no implicit number value. Call toNumber() or toString().");
  }
}
