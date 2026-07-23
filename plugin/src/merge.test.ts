import { describe, expect, it } from "vitest";
import { mergeText } from "./merge";

describe("mergeText", () => {
  it("combines disjoint line edits", () => expect(mergeText("a\nb\nc\n", "A\nb\nc\n", "a\nb\nC\n", "local", "remote")).toEqual({ text: "A\nb\nC\n", conflicted: false }));
  it("marks overlapping edits", () => expect(mergeText("a\n", "b\n", "c\n", "local", "remote").conflicted).toBe(true));
});
