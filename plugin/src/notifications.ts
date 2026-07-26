interface NotificationGroup {
  lastShownAt: number;
  suppressed: number;
}

export class NotificationGate {
  private readonly groups = new Map<string, NotificationGroup>();

  next(key: string, message: string, cooldownMs: number, now = Date.now()): string | null {
    const previous = this.groups.get(key);
    if (previous && now - previous.lastShownAt < cooldownMs) {
      previous.suppressed++;
      return null;
    }
    const suffix = previous?.suppressed
      ? ` · ${previous.suppressed} repeated notification${previous.suppressed === 1 ? "" : "s"} suppressed`
      : "";
    this.groups.set(key, { lastShownAt: now, suppressed: 0 });
    return `${message}${suffix}`;
  }
}
