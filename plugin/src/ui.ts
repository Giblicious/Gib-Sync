import { App, Modal, Notice, Platform, PluginSettingTab, Setting } from "obsidian";
import QRCode from "qrcode";
import jsQR from "jsqr";
import type { HistoryItem, PairingPayload, SetupResponse } from "@gib-sync/protocol";
import type GibSyncPlugin from "./main";
import { fromBase64Url, openPairingEnvelope } from "./crypto";

function defaultDeviceName(): string {
  if (Platform.isIosApp) return "iPhone / iPad";
  if (Platform.isAndroidApp) return "Android";
  return navigator.platform || "Desktop";
}

export class SetupModal extends Modal {
  constructor(app: App, private readonly plugin: GibSyncPlugin) { super(app); }
  onOpen() {
    this.setTitle("Set up Gib Sync");
    let server = this.plugin.settings.serverUrl || "https://sync.example.com";
    let token = ""; let vaultName = this.app.vault.getName(); let deviceName = defaultDeviceName();
    new Setting(this.contentEl).setName("Server address").addText((text) => text.setValue(server).onChange((value) => server = value.trim()));
    new Setting(this.contentEl).setName("One-time setup token").setDesc("This token is only used to enroll the first device and is never stored.").addText((text) => { text.inputEl.type = "password"; text.onChange((value) => token = value); });
    new Setting(this.contentEl).setName("Vault name").addText((text) => text.setValue(vaultName).onChange((value) => vaultName = value));
    new Setting(this.contentEl).setName("Device name").addText((text) => text.setValue(deviceName).onChange((value) => deviceName = value));
    new Setting(this.contentEl).addButton((button) => button.setCta().setButtonText("Connect").onClick(async () => {
      button.setDisabled(true).setButtonText("Connecting…");
      try { const setup = await this.plugin.api.setup(server, token, vaultName, deviceName); await this.plugin.acceptSetup(setup, deviceName); this.close(); new Notice("Gib Sync connected. Starting first sync…"); void this.plugin.runSync(); }
      catch (error) { new Notice(`Setup failed: ${error instanceof Error ? error.message : String(error)}`, 10000); button.setDisabled(false).setButtonText("Connect"); }
    }));
  }
  onClose() { this.contentEl.empty(); }
}

export class PairingQrModal extends Modal {
  constructor(app: App, private readonly plugin: GibSyncPlugin) { super(app); }
  async onOpen() {
    this.setTitle("Add a mobile device"); this.contentEl.createEl("p", { text: "On mobile, install and enable Gib Sync, choose “Scan setup QR,” then scan this code. It expires in five minutes and works once." });
    try {
      const pairing = await this.plugin.api.createPairing();
      const image = this.contentEl.createEl("img", { cls: "gib-sync-qr", attr: { alt: "Gib Sync mobile pairing QR code" } });
      image.src = await QRCode.toDataURL(pairing.uri, { width: 640, margin: 2, errorCorrectionLevel: "M" });
      new Setting(this.contentEl).addButton((button) => button.setButtonText("Copy pairing link").onClick(async () => { await navigator.clipboard.writeText(pairing.uri); new Notice("Pairing link copied"); }));
      this.contentEl.createEl("p", { cls: "gib-sync-muted", text: `Expires ${new Date(pairing.expiresAt).toLocaleTimeString()}` });
    } catch (error) { this.contentEl.createEl("p", { cls: "gib-sync-danger", text: error instanceof Error ? error.message : String(error) }); }
  }
  onClose() { this.contentEl.empty(); }
}

export class ScannerModal extends Modal {
  private stream: MediaStream | null = null; private frame = 0; private stopped = false;
  constructor(app: App, private readonly plugin: GibSyncPlugin) { super(app); }
  async onOpen() {
    this.setTitle("Scan Gib Sync setup QR");
    const video = this.contentEl.createEl("video", { cls: "gib-sync-video", attr: { playsinline: "true", muted: "true" } });
    const status = this.contentEl.createEl("p", { cls: "gib-sync-muted", text: "Requesting camera…" });
    let pasted = "";
    new Setting(this.contentEl).setName("Or paste pairing link").addText((text) => text.onChange((value) => pasted = value)).addButton((button) => button.setButtonText("Use link").onClick(() => void this.finish(pasted)));
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false }); video.srcObject = this.stream; await video.play(); status.setText("Point the camera at the QR code on your desktop.");
      const canvas = document.createElement("canvas"); const context = canvas.getContext("2d", { willReadFrequently: true });
      const scan = () => {
        if (this.stopped) return;
        if (video.readyState >= 2 && context) {
          canvas.width = video.videoWidth; canvas.height = video.videoHeight; context.drawImage(video, 0, 0);
          const image = context.getImageData(0, 0, canvas.width, canvas.height); const result = jsQR(image.data, image.width, image.height, { inversionAttempts: "dontInvert" });
          if (result?.data) { void this.finish(result.data); return; }
        }
        this.frame = requestAnimationFrame(scan);
      };
      this.frame = requestAnimationFrame(scan);
    } catch (error) { status.setText(`Camera unavailable: ${error instanceof Error ? error.message : String(error)}. Paste the pairing link above.`); }
  }
  private async finish(value: string) {
    if (!value) return; this.stopped = true; cancelAnimationFrame(this.frame); this.stream?.getTracks().forEach((track) => track.stop());
    try { await this.plugin.claimPairingLink(value, defaultDeviceName()); this.close(); new Notice("Device paired. Starting first sync…"); void this.plugin.runSync(); }
    catch (error) { this.stopped = false; new Notice(`Pairing failed: ${error instanceof Error ? error.message : String(error)}`, 10000); }
  }
  onClose() { this.stopped = true; cancelAnimationFrame(this.frame); this.stream?.getTracks().forEach((track) => track.stop()); this.contentEl.empty(); }
}

export class HistoryModal extends Modal {
  constructor(app: App, private readonly plugin: GibSyncPlugin) { super(app); }
  async onOpen() {
    this.setTitle("Gib Sync history"); const container = this.contentEl.createDiv({ cls: "gib-sync-history" }); container.setText("Loading…");
    try {
      const history = await this.plugin.api.history(); container.empty();
      for (const item of history) this.row(container, item);
      if (!history.length) container.setText("No snapshots yet.");
    } catch (error) { container.setText(error instanceof Error ? error.message : String(error)); }
  }
  private row(container: HTMLElement, item: HistoryItem) {
    const row = container.createDiv({ cls: "gib-sync-history-row" }); const details = row.createDiv();
    details.createEl("strong", { text: item.message }); details.createEl("div", { cls: "gib-sync-muted", text: `${new Date(item.createdAt).toLocaleString()} · ${item.deviceName} · ${item.fileCount} files` });
    const button = row.createEl("button", { text: "Restore" }); button.onclick = async () => {
      if (!confirm(`Restore the vault snapshot from ${new Date(item.createdAt).toLocaleString()}? A new snapshot will preserve the current history.`)) return;
      button.disabled = true;
      try { await this.plugin.api.restore(item.id); this.close(); await this.plugin.runSync(); new Notice("Snapshot restored"); }
      catch (error) { new Notice(`Restore failed: ${error instanceof Error ? error.message : String(error)}`, 10000); button.disabled = false; }
    };
  }
  onClose() { this.contentEl.empty(); }
}

export class GibSyncSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: GibSyncPlugin) { super(app, plugin); }
  display() {
    this.containerEl.empty(); this.containerEl.createEl("h2", { text: "Gib Sync" }); const configured = Boolean(this.plugin.settings.deviceToken);
    new Setting(this.containerEl).setName("Status").setDesc(configured ? `Connected to ${this.plugin.settings.serverUrl} as ${this.plugin.settings.deviceName}` : "Not connected")
      .addButton((button) => button.setButtonText(configured ? "Sync now" : "Desktop setup").setCta().onClick(() => configured ? void this.plugin.runSync() : new SetupModal(this.app, this.plugin).open()));
    new Setting(this.containerEl).setName("Scan setup QR").setDesc("Use this on the new mobile device.").addButton((button) => button.setButtonText("Open scanner").onClick(() => new ScannerModal(this.app, this.plugin).open()));
    if (configured) new Setting(this.containerEl).setName("Add mobile device").setDesc("Generate a secure, one-time setup QR code.").addButton((button) => button.setButtonText("Show QR code").onClick(() => new PairingQrModal(this.app, this.plugin).open()));
    new Setting(this.containerEl).setName("Automatic sync").addToggle((toggle) => toggle.setValue(this.plugin.settings.autoSync).onChange(async (value) => { this.plugin.settings.autoSync = value; await this.plugin.saveSettings(); this.plugin.configureTimer(); }));
    new Setting(this.containerEl).setName("Sync interval").setDesc("Seconds between periodic checks (minimum 15).").addText((text) => text.setValue(String(this.plugin.settings.syncIntervalSeconds)).onChange(async (value) => { const parsed = Number(value); if (Number.isFinite(parsed)) { this.plugin.settings.syncIntervalSeconds = Math.max(15, Math.round(parsed)); await this.plugin.saveSettings(); this.plugin.configureTimer(); } }));
    new Setting(this.containerEl).setName("Sync Obsidian configuration").setDesc("Includes .obsidian except Gib Sync's own plugin directory. Disabled by default to avoid device-specific layout conflicts.").addToggle((toggle) => toggle.setValue(this.plugin.settings.syncObsidianConfig).onChange(async (value) => { this.plugin.settings.syncObsidianConfig = value; await this.plugin.saveSettings(); }));
    new Setting(this.containerEl).setName("Excluded path prefixes").setDesc("One vault-relative prefix per line.").addTextArea((area) => area.setValue(this.plugin.settings.exclusions.join("\n")).onChange(async (value) => { this.plugin.settings.exclusions = value.split("\n").map((line) => line.trim()).filter(Boolean); await this.plugin.saveSettings(); }));
    if (configured) new Setting(this.containerEl).setName("Version history").addButton((button) => button.setButtonText("Open history").onClick(() => new HistoryModal(this.app, this.plugin).open()));
  }
}

export function decodePairing(value: string): PairingPayload {
  const data = value.startsWith("obsidian://") ? new URL(value).searchParams.get("data") : value;
  if (!data) throw new Error("Pairing code is missing data");
  const payload = JSON.parse(new TextDecoder().decode(fromBase64Url(decodeURIComponent(data)))) as PairingPayload;
  if (payload.v !== 1 || !payload.server || !payload.pairingId || !payload.secret) throw new Error("Unsupported pairing code");
  return payload;
}

export async function claimSetup(plugin: GibSyncPlugin, value: string, deviceName: string): Promise<SetupResponse> {
  const payload = decodePairing(value); const response = await plugin.api.claimPairing(payload.server, payload.pairingId, payload.secret, deviceName);
  return openPairingEnvelope<SetupResponse>(response.envelope, payload.secret, payload.pairingId);
}
