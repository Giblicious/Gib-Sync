import { Notice, Plugin } from "obsidian";
import type { SetupResponse } from "@gib-sync/protocol";
import { GibSyncApi } from "./api";
import { SyncEngine } from "./engine";
import { DEFAULT_SETTINGS, type GibSyncSettings, loadSettings } from "./settings";
import { GibSyncSettingTab, HistoryModal, PairingQrModal, ScannerModal, SetupModal, claimSetup } from "./ui";

export default class GibSyncPlugin extends Plugin {
  settings: GibSyncSettings = { ...DEFAULT_SETTINGS }; api!: GibSyncApi; engine!: SyncEngine;
  private statusEl!: HTMLElement; private timer: number | null = null; private debounce: number | null = null;

  async onload() {
    this.settings = await loadSettings(this); this.api = new GibSyncApi(() => this.settings);
    this.statusEl = this.addStatusBarItem(); this.setStatus(this.settings.deviceToken ? "Gib Sync ready" : "Gib Sync not configured");
    this.engine = new SyncEngine(this.app.vault.adapter, this.api, () => this.settings, () => this.saveSettings(), (message) => this.setStatus(message));
    this.addRibbonIcon("refresh-cw", "Gib Sync now", () => void this.runSync());
    this.addCommand({ id: "sync-now", name: "Sync now", callback: () => void this.runSync() });
    this.addCommand({ id: "desktop-setup", name: "Set up first device", callback: () => new SetupModal(this.app, this).open() });
    this.addCommand({ id: "show-pairing-qr", name: "Show mobile setup QR", checkCallback: (checking) => { if (!this.settings.deviceToken) return false; if (!checking) new PairingQrModal(this.app, this).open(); return true; } });
    this.addCommand({ id: "scan-pairing-qr", name: "Scan setup QR", callback: () => new ScannerModal(this.app, this).open() });
    this.addCommand({ id: "open-history", name: "Open version history", checkCallback: (checking) => { if (!this.settings.deviceToken) return false; if (!checking) new HistoryModal(this.app, this).open(); return true; } });
    this.registerObsidianProtocolHandler("gib-sync", async (params) => { if (params.data) { try { await this.claimPairingLink(params.data, navigator.platform || "Mobile"); new Notice("Gib Sync paired"); void this.runSync(); } catch (error) { new Notice(`Pairing failed: ${error instanceof Error ? error.message : String(error)}`, 10000); } } });
    this.addSettingTab(new GibSyncSettingTab(this.app, this));
    this.registerEvent(this.app.vault.on("create", () => this.scheduleSync()));
    this.registerEvent(this.app.vault.on("modify", () => this.scheduleSync()));
    this.registerEvent(this.app.vault.on("delete", () => this.scheduleSync()));
    this.registerEvent(this.app.vault.on("rename", () => this.scheduleSync()));
    this.configureTimer();
    if (this.settings.deviceToken && this.settings.autoSync) this.app.workspace.onLayoutReady(() => this.scheduleSync(2500));
  }

  onunload() { if (this.timer !== null) window.clearInterval(this.timer); if (this.debounce !== null) window.clearTimeout(this.debounce); }
  setStatus(message: string) { this.statusEl?.setText(message); this.statusEl?.setAttr("aria-label", message); }
  async saveSettings() { await this.saveData(this.settings); }
  async acceptSetup(setup: SetupResponse, deviceName: string) {
    Object.assign(this.settings, { serverUrl: setup.serverUrl, vaultId: setup.vaultId, vaultName: setup.vaultName, vaultKey: setup.vaultKey, deviceId: setup.deviceId, deviceToken: setup.deviceToken, deviceName, lastSnapshotId: null, initialized: false });
    await this.saveSettings(); this.configureTimer();
  }
  async claimPairingLink(value: string, deviceName: string) { await this.acceptSetup(await claimSetup(this, value, deviceName), deviceName); }
  async runSync() {
    if (!this.settings.deviceToken) { new SetupModal(this.app, this).open(); return; }
    try { const result = await this.engine.sync(); if (result.conflicts) new Notice(`Gib Sync preserved ${result.conflicts} conflict${result.conflicts === 1 ? "" : "s"}.`, 8000); }
    catch (error) { console.error("Gib Sync failed", error); this.setStatus("Gib Sync error"); new Notice(`Gib Sync failed: ${error instanceof Error ? error.message : String(error)}`, 10000); }
  }
  scheduleSync(delay = 2000) {
    if (!this.settings.autoSync || !this.settings.deviceToken) return;
    if (this.debounce !== null) window.clearTimeout(this.debounce);
    this.debounce = window.setTimeout(() => { this.debounce = null; void this.runSync(); }, delay);
  }
  configureTimer() {
    if (this.timer !== null) window.clearInterval(this.timer); this.timer = null;
    if (this.settings.autoSync && this.settings.deviceToken) this.timer = window.setInterval(() => void this.runSync(), Math.max(15, this.settings.syncIntervalSeconds) * 1000);
  }
}
