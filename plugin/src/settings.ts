import type { Plugin } from "obsidian";

export interface GibSyncSettings {
  serverUrl: string; vaultId: string; vaultName: string; vaultKey: string;
  deviceId: string; deviceName: string; deviceToken: string;
  lastSnapshotId: string | null; initialized: boolean; autoSync: boolean;
  syncIntervalSeconds: number; syncObsidianConfig: boolean; exclusions: string[];
}

export const DEFAULT_SETTINGS: GibSyncSettings = {
  serverUrl: "", vaultId: "", vaultName: "", vaultKey: "", deviceId: "", deviceName: "", deviceToken: "",
  lastSnapshotId: null, initialized: false, autoSync: true, syncIntervalSeconds: 60, syncObsidianConfig: false,
  exclusions: [".trash/", ".git/", ".obsidian/plugins/gib-sync/"]
};

export async function loadSettings(plugin: Plugin): Promise<GibSyncSettings> {
  return Object.assign({}, DEFAULT_SETTINGS, await plugin.loadData());
}
