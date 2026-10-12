import {describe,expect,it} from 'vitest';
import {conflictCopyPath} from '@gib-sync/protocol';
const at=Date.parse('2026-01-01T00:00:00Z'),size=(text:string)=>new TextEncoder().encode(text).length;
describe('portable shared conflict-copy naming',()=>{
  it('keeps ordinary names, locations, extensions and deterministic collision numbering',()=>{const first=conflictCopyPath('Notes/Entry.md','Phone',at,new Set());expect(first).toBe('Notes/Entry (conflict - Phone - 2026-01-01 00-00-00 UTC).md');expect(conflictCopyPath('Notes/Entry.md','Phone',at,new Set([first]))).toBe('Notes/Entry (conflict - Phone - 2026-01-01 00-00-00 UTC - 2).md');});
  it.each(['x'.repeat(250),'😀'.repeat(60),'é'.repeat(120),'Entry (conflict - Phone - 2026-01-01 00-00-00 UTC)'.repeat(10)])('bounds byte length without breaking Unicode or losing file type',stem=>{const path=conflictCopyPath(`Notes/${stem}.md`,'😀'.repeat(80),at,new Set());expect(path.startsWith('Notes/')).toBe(true);expect(path.endsWith('.md')).toBe(true);expect(size(path.slice(6))).toBeLessThanOrEqual(240);expect(path).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);});
  it('retains disambiguation when long names share a truncated prefix',()=>{const prefix='x'.repeat(250);expect(conflictCopyPath(prefix+'a.md','Phone',at,new Set())).not.toBe(conflictCopyPath(prefix+'b.md','Phone',at,new Set()));});
  it('keeps extremely deep path preservation within the accepted relative-path limit',()=>{const path=conflictCopyPath('a/'.repeat(1990)+'note.md','Phone',at,new Set());expect(path.startsWith('Gib Sync Conflicts/')).toBe(true);expect(path.length).toBeLessThanOrEqual(4000);});
});
