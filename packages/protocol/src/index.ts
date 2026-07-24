export const PROTOCOL_VERSION = 4;

export interface ManifestEntry {
  path: string;
  hash: string;
  size: number;
  mtime: number;
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
}

export interface SetupResponse {
  protocolVersion: number;
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
}

export interface MirrorPlanRequest {
  snapshotId: string;
  entries: ManifestEntry[];
}

export interface MirrorPlanResponse {
  uploadPaths: string[];
  deletePaths: string[];
  alreadyCurrent: boolean;
}

export interface MirrorCompleteResponse {
  mirroredFiles: number;
  deletedFiles: number;
  snapshotId: string;
}

export interface QuickCodePairing { code:string; expiresAt:string; }
export interface QuickCodeClaim { pairingId:string; envelope:string; }

export interface SyncState {
  head: Snapshot | null;
}

export interface WatchResponse {
  changed: boolean;
  headId: string | null;
}

export interface CommitRequest {
  parentId: string | null;
  message: string;
  entries: ManifestEntry[];
}

export interface HistoryItem {
  id: string;
  parentId: string | null;
  deviceName: string;
  createdAt: string;
  message: string;
  fileCount: number;
}
