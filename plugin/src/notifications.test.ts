import { describe, expect, it } from "vitest";
import { NotificationGate } from "./notifications";

describe("NotificationGate", () => {
  it("shows the first message and suppresses repeats during the cooldown", () => {
    const gate = new NotificationGate();
    expect(gate.next("sync-error", "Sync failed", 60_000, 1_000)).toBe("Sync failed");
    expect(gate.next("sync-error", "Sync failed again", 60_000, 2_000)).toBeNull();
  });

  it("summarizes suppressed repeats when the cooldown expires", () => {
    const gate = new NotificationGate();
    gate.next("safeguard", "Changes need review", 60_000, 1_000);
    gate.next("safeguard", "Changes need review", 60_000, 2_000);
    gate.next("safeguard", "Changes need review", 60_000, 3_000);
    expect(gate.next("safeguard", "Changes still need review", 60_000, 61_000))
      .toBe("Changes still need review · 2 repeated notifications suppressed");
  });

  it("tracks unrelated notification categories independently", () => {
    const gate = new NotificationGate();
    expect(gate.next("sync-error", "Sync failed", 60_000, 1_000)).toBe("Sync failed");
    expect(gate.next("safeguard", "Changes need review", 60_000, 2_000)).toBe("Changes need review");
  });
});
