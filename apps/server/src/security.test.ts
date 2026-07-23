import { describe, expect, it } from "vitest";
import { openJson, safeEqual, sealJson, sha256 } from "./security.js";

describe("security", () => {
  it("round trips sealed JSON", () => {
    const sealed = sealJson({ key: "value" }, "x".repeat(32), "test");
    expect(openJson(sealed, "x".repeat(32), "test")).toEqual({ key: "value" });
  });
  it("compares and hashes safely", () => {
    expect(safeEqual("abc", "abc")).toBe(true); expect(safeEqual("abc", "abd")).toBe(false);
    expect(sha256("abc")).toHaveLength(64);
  });
});

