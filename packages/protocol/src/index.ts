export const PROTOCOL_VERSION = 1;

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
}

export interface PairingPayload {
  v: 1;
  server: string;
  pairingId: string;
  secret: string;
}

export interface SyncState {
  head: Snapshot | null;
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

