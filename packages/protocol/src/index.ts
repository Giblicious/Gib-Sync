export const PROTOCOL_VERSION = 7;
export const MINIMUM_SAFE_SERVER_VERSION = "0.8.55";
export const REQUIRED_SERVER_CAPABILITIES = ["readable-generation-v1","external-delete-proof-v1","folder-manifest-v1","folder-manifest-migration-v2","folder-provenance-repair-v1","folder-retirement-directive-v1","snapshot-integrity-v1","atomic-head-commit-v1","server-containment-v1"] as const;

export interface ClientCompatibility {
  clientVersion: string | null;
  clientProtocol: number | null;
  minimumVersion: string;
  recommendedVersion: string;
  serverProtocol: number;
  serverVersion?: string | null;
  serverCapabilities?: string[];
  compatible: boolean;
  updateAvailable: boolean;
  reason: string | null;
}

export interface ManifestEntry {
  path: string;
  hash: string;
  size: number;
  mtime: number;
  /** Stable identity assigned by the server; optional for protocol-7 clients. */
  fileId?: string;
  /** Authorship of this file's content, not the most recent vault commit. */
  revision?: FileRevision;
}

export interface FileRevision {
  id: string;
  parentId: string | null;
  deviceId: string;
  deviceName: string;
  modifiedAt: number;
}

export interface FolderRepairDirective {
  /** Empty folders observed through an unsafe external baseline. */
  retiredFolders: string[];
  /** Time the unsafe external folder baseline was observed. */
  observedAt: string;
  /** Time the server issued the cleanup directive. Added in 0.8.54. */
  issuedAt?: string;
  originSnapshotIds: string[];
}

export interface Snapshot {
  id: string;
  vaultId: string;
  parentId: string | null;
  deviceId: string;
  deviceName: string;
  createdAt: string;
  message: string;
  entries: ManifestEntry[];
  /** Explicit accepted folder topology. Omitted by snapshots created before protocol 7. */
  folders?: string[];
  /** Stable identities for the complete folder tree; additive for legacy clients. */
  folderEntries?: import("./operations.js").FolderEntry[];
  /** Server-authored cleanup guidance retained across descendant snapshots. */
  folderRepair?: FolderRepairDirective;
}

/** Authenticated metadata delta. Applying it never acknowledges a device. */
export interface SnapshotDelta {
  baseId:string;
  snapshot:Omit<Snapshot,"entries">;
  changed:ManifestEntry[];
  removed:string[];
}

export interface SetupResponse {
  protocolVersion: number;
  serverVersion?: string | null;
  serverCapabilities?: string[];
  serverUrl: string;
  vaultId: string;
  vaultName: string;
  deviceId: string;
  deviceToken: string;
  vaultKey: string;
  head: Snapshot | null;
  storage: StorageLocation;
}

export interface StorageLocation {
  seafileUrl: string;
  username: string;
  libraryId: string;
  libraryName: string;
  basePath: string;
  readablePath: string;
}

export interface SeafileLibrary {
  id: string;
  name: string;
}

export interface StorageDiscovery {
  username: string;
  libraries: SeafileLibrary[];
  existingVaults: ExistingVaultLocation[];
}

export interface ExistingVaultLocation {
  vaultId: string;
  vaultName: string;
  libraryId: string;
  libraryName: string;
  basePath: string;
}

export interface StorageSetupRequest {
  vaultName: string;
  deviceName: string;
  seafileUrl: string;
  seafileUsername: string;
  seafilePassword: string;
  libraryId: string;
  libraryName: string;
  basePath: string;
  existingVaultId?: string;
}

export interface ServerStatus {
  protocolVersion: number;
  serverVersion?: string | null;
  serverCapabilities?: string[];
  vaultId: string;
  vaultName: string;
  deviceId: string;
  deviceName: string;
  deviceCount: number;
  snapshotCount: number;
  blobCount: number;
  blobBytes: number;
  head: Snapshot | null;
  storage: StorageLocation;
  serverTime: string;
  mirrorHeadId: string | null;
  mirrorFileCount: number;
  mirrorCurrent: boolean;
  externalScanAt: string | null;
  externalImportAt: string | null;
  externalError: string | null;
  containment?: ServerContainmentStatus;
  safeguards: SafeguardState;
  healthAlerts: HealthAlert[];
  devices: DeviceInfo[];
  compatibility: ClientCompatibility;
  projection?: {state:"idle"|"queued"|"running"|"retrying";attempts:number;lastError:string|null};
}

export interface ServerContainmentStatus {
  active:boolean;
  thisVaultAllowed:boolean;
  enabledAt:string|null;
  reason:string|null;
}

export interface MirrorPlanRequest {
  snapshotId: string;
  entries: ManifestEntry[];
}

export interface MirrorPlanResponse {
  /** New servers own durable projection; old servers retain client uploads. */
  serverManaged?: boolean;
  uploadPaths: string[];
  deletePaths: string[];
  alreadyCurrent: boolean;
}

export interface MirrorCompleteResponse {
  mirroredFiles: number;
  deletedFiles: number;
  snapshotId: string;
}

export interface QuickCodePairing { code:string; expiresAt:string; setupUrl?:string; }
export interface QuickCodeClaim { pairingId:string; envelope:string; }

export interface SyncState {
  head: Snapshot | null;
}

export interface WatchResponse {
  changed: boolean;
  headId: string | null;
  attention?: boolean;
}

export interface CommitRequest {
  parentId: string | null;
  message: string;
  entries: ManifestEntry[];
  folders?: string[];
  folderEntries?: import("./operations.js").FolderEntry[];
  clientTime?: string;
  signals?: ClientSafetySignals;
}

export interface HistoryItem {
  id: string;
  parentId: string | null;
  deviceName: string;
  createdAt: string;
  message: string;
  fileCount: number;
  bookmarked: boolean;
}

export type SafeguardMode = "strict" | "balanced" | "custom";

export interface SafeguardPolicy {
  mode: SafeguardMode;
  deletionCount: number;
  smallVaultDeletionCount: number;
  smallVaultDeletionPercent: number;
  changedCount: number;
  changedPercent: number;
  folderImpactCount: number;
  fileGrowthBytes: number;
  fileGrowthPercent: number;
  clockSkewMinutes: number;
  protectedPaths: string[];
}

export interface ClientSafetySignals {
  highEntropyPaths?: string[];
  deviceLocalCleanupPaths?: string[];
  vaultIdentity?: string;
  staleBaseline?: boolean;
}

export interface ChangeItem {
  path: string;
  kind: "created" | "modified" | "deleted" | "moved";
  previousPath?: string;
  previousSize?: number;
  size?: number;
}

export interface ChangeAssessment {
  created: number;
  modified: number;
  deleted: number;
  moved: number;
  totalChanged: number;
  affectedPercent: number;
  bytesAdded: number;
  bytesRemoved: number;
  reasons: string[];
  examples: ChangeItem[];
}

export interface QuarantineItem {
  id: string;
  proposalHash: string;
  source: "device" | "seafile";
  deviceId: string;
  deviceName: string;
  parentId: string | null;
  createdAt: string;
  expiresAt: string;
  status: "pending" | "approved" | "rejected" | "stale";
  message: string;
  assessment: ChangeAssessment;
  changes: ChangeItem[];
}

export interface SafeguardState {
  policy: SafeguardPolicy;
  writeLocked: boolean;
  writeLockedAt: string | null;
  writeLockedBy: string | null;
  trustedUntil: string | null;
  pendingQuarantines: number;
}

export interface DeviceInfo {
  id: string;
  name: string;
  createdAt: string;
  lastSeenAt: string;
  revokedAt: string | null;
  ready: boolean;
  clockSkewMs: number;
  current: boolean;
  clientVersion: string | null;
  clientProtocol: number | null;
  compatibility: "compatible"|"update-available"|"incompatible";
  acknowledgedSnapshotId?: string | null;
  acknowledgedAt?: string | null;
}

export { mergeJsonValues } from "./json-merge.js";
export { mergeText, type MergeKind, type MergeResult } from "./text-merge.js";
export * from "./operations.js";

export interface HealthAlert {
  code: string;
  level: "info" | "warning" | "error";
  message: string;
  at: string;
}

export interface DetectedMove {
  previousPath: string;
  path: string;
}

const movedPrefix=(previousPath:string,path:string):{previous:string;next:string}|null=>{
  const previous=previousPath.split("/"),next=path.split("/");let suffix=0;
  while(suffix<previous.length&&suffix<next.length&&previous[previous.length-1-suffix]===next[next.length-1-suffix])suffix++;
  if(!suffix)return null;const previousPrefix=previous.slice(0,previous.length-suffix).join("/"),nextPrefix=next.slice(0,next.length-suffix).join("/");
  return previousPrefix!==nextPrefix?{previous:previousPrefix,next:nextPrefix}:null;
};

/** Detects stable path moves, including edited files inside a folder move. */
export function detectMoves(previous:ManifestEntry[],next:ManifestEntry[],mode:"identity"|"assessment"="assessment"):DetectedMove[]{
  const before=new Map(previous.map((entry)=>[entry.path,entry])),after=new Map(next.map((entry)=>[entry.path,entry]));
  const removed=[...before.values()].filter((entry)=>!after.has(entry.path)),created=[...after.values()].filter((entry)=>!before.has(entry.path));
  const removedByHash=new Map<string,ManifestEntry[]>(),createdByHash=new Map<string,ManifestEntry[]>();
  for(const entry of removed){const group=removedByHash.get(entry.hash)??[];group.push(entry);removedByHash.set(entry.hash,group);}
  for(const entry of created){const group=createdByHash.get(entry.hash)??[];group.push(entry);createdByHash.set(entry.hash,group);}
  const result=new Map<string,string>(),usedCreated=new Set<string>();
  const identityBefore=new Map<string,ManifestEntry[]>(),identityAfter=new Map<string,ManifestEntry[]>();
  for(const entry of previous)if(entry.fileId){const group=identityBefore.get(entry.fileId)??[];group.push(entry);identityBefore.set(entry.fileId,group);}
  for(const entry of next)if(entry.fileId){const group=identityAfter.get(entry.fileId)??[];group.push(entry);identityAfter.set(entry.fileId,group);}
  for(const source of removed){
    if(!source.fileId||identityBefore.get(source.fileId)?.length!==1)continue;
    const destinations=identityAfter.get(source.fileId)??[],destination=destinations[0];
    if(destinations.length!==1||!destination||before.has(destination.path)||!created.some(item=>item.path===destination.path))continue;
    result.set(source.path,destination.path);usedCreated.add(destination.path);
  }
  for(const [hash,sources] of removedByHash){const destinations=createdByHash.get(hash)??[];if(sources.length!==1||destinations.length!==1||result.has(sources[0].path)||usedCreated.has(destinations[0].path))continue;if(sources[0].fileId&&destinations[0].fileId&&sources[0].fileId!==destinations[0].fileId)continue;result.set(sources[0].path,destinations[0].path);usedCreated.add(destinations[0].path);}
  // Structural resemblance is useful when assessing a deletion batch, but is
  // not proof that two edited files share an ancestor. Merge planning must use
  // identity mode so similarly named notes cannot inherit each other's base.
  if(mode==="identity")return [...result].map(([previousPath,path])=>({previousPath,path})).sort((a,b)=>a.previousPath.localeCompare(b.previousPath));

  // Exact matches reveal a folder-prefix move. A batch whose bytes all changed
  // can still reveal the same relocation through unique filenames and similar
  // sizes. This is intentionally batch-only: three agreeing paths are needed
  // before edited structural matches can establish a folder mapping.
  const prefixCounts=new Map<string,{previous:string;next:string;count:number;exact:number}>();
  const support=(source:string,destination:string,exact:boolean)=>{const prefixes=movedPrefix(source,destination);if(!prefixes)return;const key=`${prefixes.previous}\0${prefixes.next}`,current=prefixCounts.get(key);
    if(current){current.count++;if(exact)current.exact++;}else prefixCounts.set(key,{...prefixes,count:1,exact:exact?1:0});};
  for(const [source,destination] of result)support(source,destination,true);
  const name=(path:string)=>path.slice(path.lastIndexOf("/")+1),extension=(path:string)=>{const value=name(path),index=value.lastIndexOf(".");return index<0?"":value.slice(index+1).toLowerCase();};
  const remainingRemoved=removed.filter((entry)=>!result.has(entry.path)),remainingCreated=created.filter((entry)=>!usedCreated.has(entry.path));
  const removedByName=new Map<string,ManifestEntry[]>(),createdByName=new Map<string,ManifestEntry[]>();
  for(const entry of remainingRemoved){const group=removedByName.get(name(entry.path))??[];group.push(entry);removedByName.set(name(entry.path),group);}
  for(const entry of remainingCreated){const group=createdByName.get(name(entry.path))??[];group.push(entry);createdByName.set(name(entry.path),group);}
  for(const [filename,sources] of removedByName){const destinations=createdByName.get(filename)??[];if(sources.length!==1||destinations.length!==1)continue;
    const source=sources[0],destination=destinations[0],largest=Math.max(source.size,destination.size),sizeDifference=Math.abs(source.size-destination.size);
    if(extension(source.path)!==extension(destination.path)||sizeDifference>Math.max(64*1024,largest*0.5))continue;support(source.path,destination.path,false);
  }
  const mappings=[...prefixCounts.values()].filter((item)=>item.exact>=2||item.count>=3).sort((left,right)=>right.previous.length-left.previous.length||right.count-left.count);
  for(const source of removed){if(result.has(source.path))continue;
    for(const mapping of mappings){const prefix=mapping.previous?`${mapping.previous}/`:"";if(prefix&&!source.path.startsWith(prefix))continue;
      const suffix=prefix?source.path.slice(prefix.length):source.path,candidate=mapping.next?`${mapping.next}/${suffix}`:suffix;
      if(usedCreated.has(candidate)||before.has(candidate)||!after.has(candidate))continue;result.set(source.path,candidate);usedCreated.add(candidate);break;
    }
  }
  return [...result].map(([previousPath,path])=>({previousPath,path})).sort((left,right)=>left.previousPath.localeCompare(right.previousPath));
}

export interface HealthRepairResult {
  headId: string | null;
  mirrorCurrent: boolean;
  restoredFiles: number;
  removedFiles: number;
  removedConflictCopies: number;
  dismissedQuarantines: number;
  clearedAlerts: number;
}

export interface RestorePreview {
  snapshotId: string;
  snapshotCreatedAt: string;
  snapshotDeviceName: string;
  assessment: ChangeAssessment;
  confirmToken: string;
  expiresAt: string;
}

export interface SelectiveRestoreChange extends ChangeItem {
  id: string;
}

export interface SelectiveRestorePlan {
  snapshotId: string;
  changes: SelectiveRestoreChange[];
}

export interface SelectiveRestorePreview extends RestorePreview {
  selectedChanges: number;
}
