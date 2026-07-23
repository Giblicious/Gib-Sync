import { diffArrays } from "diff";

type Hunk = { start: number; remove: number; add: string[] };

function hunks(base: string[], changed: string[]): Hunk[] {
  const parts = diffArrays(base, changed); const output: Hunk[] = []; let baseIndex = 0;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part.added && !part.removed) { baseIndex += part.value.length; continue; }
    const hunk: Hunk = { start: baseIndex, remove: 0, add: [] };
    while (i < parts.length && (parts[i].added || parts[i].removed)) {
      const current = parts[i];
      if (current.removed) { hunk.remove += current.value.length; baseIndex += current.value.length; }
      if (current.added) hunk.add.push(...current.value);
      i++;
    }
    i--; output.push(hunk);
  }
  return output;
}

function overlaps(a: Hunk, b: Hunk): boolean {
  const aEnd = a.start + a.remove, bEnd = b.start + b.remove;
  if (a.remove === 0 && b.remove === 0) return a.start === b.start;
  return (a.start < bEnd && b.start < aEnd) || (a.remove === 0 && a.start >= b.start && a.start <= bEnd) || (b.remove === 0 && b.start >= a.start && b.start <= aEnd);
}

export function mergeText(baseText: string, localText: string, remoteText: string, localName: string, remoteName: string): { text: string; conflicted: boolean } {
  if (localText === remoteText) return { text: localText, conflicted: false };
  if (localText === baseText) return { text: remoteText, conflicted: false };
  if (remoteText === baseText) return { text: localText, conflicted: false };
  const trailing = baseText.endsWith("\n"); const split = (v: string) => v.replace(/\n$/, "").split("\n");
  const base = split(baseText), local = hunks(base, split(localText)), remote = hunks(base, split(remoteText));
  if (local.some((l) => remote.some((r) => overlaps(l, r)))) return { text: `<<<<<<< ${localName}\n${localText}\n=======\n${remoteText}\n>>>>>>> ${remoteName}\n`, conflicted: true };
  const result = [...base];
  for (const h of [...local, ...remote].sort((a,b) => b.start - a.start)) result.splice(h.start, h.remove, ...h.add);
  return { text: result.join("\n") + (trailing ? "\n" : ""), conflicted: false };
}
