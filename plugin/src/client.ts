import { requestUrl, type RequestUrlResponse } from "obsidian";
import type { AssetKind, CaptureFile, CaptureOrigin, CaptureSettings, Job } from "./api";

export class ServerError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export interface Health {
  status: string;
  apiVersion: number;
  version: string;
}

/** Thin HTTP client for bookmarks-server. requestUrl works on desktop and mobile and skips CORS. */
export class ServerClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  private async request(method: string, path: string, body?: unknown): Promise<RequestUrlResponse> {
    if (!this.baseUrl) throw new ServerError("Set the server URL in Bookmarks settings.", 0);
    const response = await requestUrl({
      url: new URL(path, this.baseUrl).toString(),
      method,
      headers: { Authorization: `Bearer ${this.token}` },
      contentType: body === undefined ? undefined : "application/json",
      body: body === undefined ? undefined : JSON.stringify(body),
      throw: false,
    });
    if (response.status >= 400) {
      let message = `Server returned HTTP ${response.status}`;
      try {
        const json = response.json as { message?: string; error?: string };
        message = json.message ?? json.error ?? message;
      } catch {
        // not JSON
      }
      if (response.status === 401) message = "The server rejected the API token.";
      throw new ServerError(message, response.status);
    }
    return response;
  }

  async health(): Promise<Health> {
    return (await this.request("GET", "/health")).json as Health;
  }

  /**
   * With `wait`, the server holds the request until the job settles or its wait cap passes.
   * `files` are capture files to make even if the rendered note doesn't use them.
   */
  async capture(url: string, origin: CaptureOrigin, wait: boolean, template: string | null = null, files: readonly CaptureFile[] = []): Promise<Job> {
    const response = await this.request("POST", `/capture${wait ? "?wait=1" : ""}`, {
      url,
      origin,
      ...(template ? { template } : {}),
      ...(files.length ? { files } : {}),
    });
    return (response.json as { job: Job }).job;
  }

  async job(id: string): Promise<Job> {
    return ((await this.request("GET", `/jobs/${id}`)).json as { job: Job }).job;
  }

  async finishedJobs(): Promise<Job[]> {
    return ((await this.request("GET", "/jobs?status=done,failed&limit=50")).json as { jobs: Job[] }).jobs;
  }

  async assetText(id: string, kind: AssetKind): Promise<string> {
    return (await this.request("GET", `/jobs/${id}/asset/${kind}`)).text;
  }

  async assetBinary(id: string, kind: AssetKind): Promise<ArrayBuffer> {
    return (await this.request("GET", `/jobs/${id}/asset/${kind}`)).arrayBuffer;
  }

  /** Capture settings shared by every device, kept on the server. */
  async getSettings(): Promise<CaptureSettings> {
    return ((await this.request("GET", "/settings")).json as { settings: CaptureSettings }).settings;
  }

  async saveSettings(settings: CaptureSettings): Promise<CaptureSettings> {
    return ((await this.request("PUT", "/settings", settings)).json as { settings: CaptureSettings }).settings;
  }

  async delivered(id: string): Promise<void> {
    await this.request("POST", `/jobs/${id}/delivered`);
  }

  /** Stops a capture that hasn't finished; the server throws its result away. */
  async cancel(id: string): Promise<void> {
    await this.request("POST", `/jobs/${id}/cancel`);
  }
}
