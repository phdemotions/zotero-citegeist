import { describe, it, expect } from "vitest";
import { escapeHTML, safeParseInt, safeParseFloat } from "../src/modules/utils";

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
