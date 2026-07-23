import type { Config } from "./config.js";

type Repo = { id: string; name: string };

export class SeafileStorage {
  private token = "";
  private repoId = "";
  constructor(private readonly config: Config) {}

  private async request(path: string, init: RequestInit = {}, retry = true): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.token) headers.set("Authorization", `Token ${this.token}`);
    const response = await fetch(new URL(path, this.config.SEAFILE_URL), { ...init, headers });
    if (response.status === 401 && retry) { await this.authenticate(); return this.request(path, init, false); }
    return response;
  }

  async authenticate(): Promise<void> {
    const body = new URLSearchParams({ username: this.config.SEAFILE_USERNAME, password: this.config.SEAFILE_PASSWORD });
    const response = await fetch(new URL("/api2/auth-token/", this.config.SEAFILE_URL), { method: "POST", body });
    if (!response.ok) throw new Error(`Seafile authentication failed (${response.status})`);
    this.token = (await response.json() as { token: string }).token;
  }

  async init(): Promise<void> {
    await this.authenticate();
    const list = await this.request("/api2/repos/");
    if (!list.ok) throw new Error(`Unable to list Seafile libraries (${list.status})`);
    const repos = await list.json() as Repo[];
    let repo = repos.find((r) => r.name === this.config.SEAFILE_LIBRARY);
    if (!repo) {
      const body = new URLSearchParams({ name: this.config.SEAFILE_LIBRARY, desc: "Encrypted Gib Sync snapshots and content-addressed blobs" });
      const created = await this.request("/api2/repos/", { method: "POST", body });
      if (!created.ok) throw new Error(`Unable to create Seafile library (${created.status}: ${await created.text()})`);
      repo = await created.json() as Repo;
    }
    this.repoId = repo.id;
    for (const path of ["/vaults"]) await this.mkdir(path);
  }

  private async mkdir(path: string): Promise<void> {
    const response = await this.request(`/api2/repos/${this.repoId}/dir/?p=${encodeURIComponent(path)}`, {
      method: "POST", body: new URLSearchParams({ operation: "mkdir" })
    });
    if (!response.ok && response.status !== 400) throw new Error(`Seafile mkdir ${path} failed (${response.status})`);
  }

  private async ensureParents(path: string): Promise<void> {
    const parts = path.split("/").filter(Boolean).slice(0, -1); let current = "";
    for (const part of parts) { current += `/${part}`; await this.mkdir(current); }
  }

  async put(path: string, bytes: Uint8Array, contentType = "application/octet-stream"): Promise<void> {
    await this.ensureParents(path);
    const parent = path.slice(0, path.lastIndexOf("/")) || "/";
    const name = path.slice(path.lastIndexOf("/") + 1);
    const linkResponse = await this.request(`/api2/repos/${this.repoId}/upload-link/?p=${encodeURIComponent(parent)}`);
    if (!linkResponse.ok) throw new Error(`Seafile upload link failed (${linkResponse.status})`);
    const uploadUrl = await linkResponse.json() as string;
    const form = new FormData();
    form.set("parent_dir", parent); form.set("replace", "1");
    form.set("file", new Blob([bytes.slice().buffer], { type: contentType }), name);
    const response = await this.request(uploadUrl, { method: "POST", body: form });
    if (!response.ok) throw new Error(`Seafile upload ${path} failed (${response.status}: ${await response.text()})`);
  }

  async get(path: string): Promise<Uint8Array> {
    const link = await this.request(`/api2/repos/${this.repoId}/file/?p=${encodeURIComponent(path)}`);
    if (!link.ok) throw new Error(`Seafile file link failed (${link.status})`);
    const url = await link.json() as string;
    const response = await this.request(url);
    if (!response.ok) throw new Error(`Seafile download failed (${response.status})`);
    return new Uint8Array(await response.arrayBuffer());
  }
}
