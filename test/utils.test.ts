import { describe, it, expect } from "vitest";
import {
  escapeHTML,
  safeParseInt,
  safeParseFloat,
  normalizeError,
  OpenAlexNetworkError,
  rawHTML,
  safeHTML,
  toOrdinal,
} from "../src/modules/utils";

describe("escapeHTML", () => {
  it("escapes ampersands", () => {
    expect(escapeHTML("A & B")).toBe("A &amp; B");
  });

  it("escapes angle brackets", () => {
    expect(escapeHTML("<script>alert('xss')</script>")).toBe(
      "&lt;script&gt;alert(&#39;xss&#39;)&lt;/script&gt;",
    );
  });

  it("escapes double quotes", () => {
    expect(escapeHTML('say "hello"')).toBe("say &quot;hello&quot;");
  });

  it("escapes single quotes", () => {
    expect(escapeHTML("it's")).toBe("it&#39;s");
  });

  it("handles empty string", () => {
    expect(escapeHTML("")).toBe("");
  });

  it("returns plain text unchanged", () => {
    expect(escapeHTML("hello world")).toBe("hello world");
  });

  it("escapes all five HTML-significant characters together", () => {
    expect(escapeHTML(`<a href="x" title='y'>&</a>`)).toBe(
      "&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;",
    );
  });
});

describe("safeParseInt", () => {
  it("parses a valid integer string", () => {
    expect(safeParseInt("42")).toBe(42);
  });

  it("parses zero", () => {
    expect(safeParseInt("0")).toBe(0);
  });

  it("parses negative numbers", () => {
    expect(safeParseInt("-5")).toBe(-5);
  });

  it("returns fallback for undefined", () => {
    expect(safeParseInt(undefined)).toBe(0);
  });

  it("returns custom fallback for undefined", () => {
    expect(safeParseInt(undefined, -1)).toBe(-1);
  });

  it("returns fallback for non-numeric string", () => {
    expect(safeParseInt("abc")).toBe(0);
  });

  it("returns fallback for empty string", () => {
    expect(safeParseInt("")).toBe(0);
  });

  it("truncates floats to integer", () => {
    expect(safeParseInt("3.9")).toBe(3);
  });
});

describe("safeParseFloat", () => {
  it("parses a valid float string", () => {
    expect(safeParseFloat("2.31")).toBe(2.31);
  });

  it("parses an integer as float", () => {
    expect(safeParseFloat("42")).toBe(42);
  });

  it("parses zero", () => {
    expect(safeParseFloat("0")).toBe(0);
  });

  it("returns null for undefined", () => {
    expect(safeParseFloat(undefined)).toBeNull();
  });

  it("returns null for non-numeric string", () => {
    expect(safeParseFloat("abc")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(safeParseFloat("")).toBeNull();
  });

  it("parses negative floats", () => {
    expect(safeParseFloat("-1.5")).toBe(-1.5);
  });
});

describe("normalizeError", () => {
  it("extracts message from an Error instance", () => {
    const err = new Error("boom");
    const out = normalizeError(err);
    expect(out).toContain("boom");
  });

  it("returns strings as-is", () => {
    expect(normalizeError("plain message")).toBe("plain message");
  });

  it("stringifies plain objects", () => {
    expect(normalizeError({ code: 500, msg: "x" })).toBe('{"code":500,"msg":"x"}');
  });

  it("handles null", () => {
    expect(normalizeError(null)).toBe("null");
  });

  it("handles undefined", () => {
    expect(normalizeError(undefined)).toBe("undefined");
  });

  it("falls back for values that cannot be JSON-serialized", () => {
    const circ: Record<string, unknown> = {};
    circ.self = circ;
    // Should not throw; falls back to String()
    expect(() => normalizeError(circ)).not.toThrow();
    expect(typeof normalizeError(circ)).toBe("string");
  });

  it("normalizes an OpenAlexNetworkError", () => {
    const err = new OpenAlexNetworkError("unreachable");
    expect(normalizeError(err)).toContain("unreachable");
    expect(err.name).toBe("OpenAlexNetworkError");
  });
});

describe("toOrdinal", () => {
  it("handles 1st, 2nd, 3rd, 4th", () => {
    expect(toOrdinal(1)).toBe("1st");
    expect(toOrdinal(2)).toBe("2nd");
    expect(toOrdinal(3)).toBe("3rd");
    expect(toOrdinal(4)).toBe("4th");
  });

  it("teen exceptions: 11th, 12th, 13th", () => {
    expect(toOrdinal(11)).toBe("11th");
    expect(toOrdinal(12)).toBe("12th");
    expect(toOrdinal(13)).toBe("13th");
  });

  it("teen exceptions in higher ranges: 111th, 112th", () => {
    expect(toOrdinal(111)).toBe("111th");
    expect(toOrdinal(112)).toBe("112th");
  });

  it("larger values: 21st, 92nd, 93rd, 100th", () => {
    expect(toOrdinal(21)).toBe("21st");
    expect(toOrdinal(92)).toBe("92nd");
    expect(toOrdinal(93)).toBe("93rd");
    expect(toOrdinal(100)).toBe("100th");
  });

  it("121st — not a teen exception (121 % 100 = 21)", () => {
    expect(toOrdinal(121)).toBe("121st");
  });

  it("0th boundary", () => {
    expect(toOrdinal(0)).toBe("0th");
  });
});

describe("safeHTML tagged template", () => {
  it("escapes interpolated values by default", () => {
    const userInput = "<script>alert(1)</script>";
    const out = safeHTML`<p>${userInput}</p>`;
    expect(out).toBe("<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>");
  });

  it("escapes quotes in attribute values", () => {
    const title = `a "quoted" value`;
    const out = safeHTML`<a title="${title}">x</a>`;
    expect(out).toBe(`<a title="a &quot;quoted&quot; value">x</a>`);
  });

  it("leaves rawHTML() values unescaped", () => {
    const safe = rawHTML("<strong>bold</strong>");
    const out = safeHTML`<p>${safe}</p>`;
    expect(out).toBe("<p><strong>bold</strong></p>");
  });

  it("renders null and undefined as empty strings", () => {
    expect(safeHTML`<p>${null}${undefined}</p>`).toBe("<p></p>");
  });

  it("coerces numbers to strings", () => {
    expect(safeHTML`<p>${42}</p>`).toBe("<p>42</p>");
  });

  it("handles templates with no interpolations", () => {
    expect(safeHTML`<p>hello</p>`).toBe("<p>hello</p>");
  });
});
