import {describe,expect,it} from 'vitest';
import {externalCreationProofs} from './external-provenance.js';
import type {ReadableEvent} from './seafile.js';
const event=(operation:ReadableEvent['operation'],path:string,extra:Partial<ReadableEvent>={}):ReadableEvent=>({operation,path,commitId:'a'.repeat(40),mtime:1,...extra});
describe('chronological external creation proof',()=>{
  it('keeps creation identity through chained file renames',()=>{const proofs=externalCreationProofs([event('created','new.md'),event('renamed','middle.md',{previousPath:'new.md'}),event('renamed','final.md',{previousPath:'middle.md'})],[]);expect([...proofs.keys()]).toEqual(['final.md']);expect(proofs.get('final.md')).toMatchObject({originPath:'new.md',recreated:false});});
  it('propagates collapsed directory recreation to old descendants before a later rename',()=>{const proofs=externalCreationProofs([event('deleted','A',{directory:true}),event('created','A',{directory:true,commitId:'b'.repeat(40)}),event('renamed','B',{previousPath:'A'})],['A','A/note.md','A/Empty']);expect([...proofs.keys()].sort()).toEqual(['B','B/Empty','B/note.md']);expect(proofs.get('B/note.md')).toMatchObject({originPath:'A/note.md',commitId:'b'.repeat(40),recreated:true});expect(proofs.get('B/Empty')).toMatchObject({originPath:'A/Empty',recreated:true});});
  it('does not preserve a disappeared creation proof or confuse a neighboring prefix',()=>{const proofs=externalCreationProofs([event('created','A/note.md'),event('created','Another/note.md'),event('renamed','B',{previousPath:'A'}),event('deleted','B',{directory:true})],[]);expect([...proofs.keys()]).toEqual(['Another/note.md']);});
});
