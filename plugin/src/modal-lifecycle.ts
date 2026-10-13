export interface OwnedDialog {close():void;}
/** One registry per loaded plugin instance; closed dialogs are not retained. */
export class ModalRegistry {
  private readonly dialogs=new Set<OwnedDialog>();
  private disposed=false;
  add(dialog:OwnedDialog):void{if(this.disposed)throw new Error('This Gib Sync instance was unloaded; reopen its settings after the update.');this.dialogs.add(dialog);}
  release(dialog:OwnedDialog):void{this.dialogs.delete(dialog);}
  dispose():number{this.disposed=true;const pending=[...this.dialogs];this.dialogs.clear();let failures=0;for(const dialog of pending)try{dialog.close();}catch{failures++;}return failures;}
  get size():number{return this.dialogs.size;}
}

/** Earlier versions did not register their windows. Use Obsidian's normal
 * close action on the exact Gib Sync content marker, never another plugin's UI. */
export function closeLegacyPluginDialogs(root:ParentNode):number{
  const seen=new Set<Element>();let closed=0;
  for(const content of Array.from(root.querySelectorAll('.gib-sync-modal-content')).reverse()){const modal=content.closest('.modal-container');if(!modal||seen.has(modal))continue;seen.add(modal);const action=modal.querySelector<HTMLElement>('.modal-close-button')??modal.querySelector<HTMLElement>('.modal-header-button');if(action)try{action.click();closed++;}catch{/* A stale native close failure must not disable the newly loaded plugin. */}}
  return closed;
}
