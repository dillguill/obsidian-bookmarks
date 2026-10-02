import { requestUrl, type RequestUrlResponse } from "obsidian";
import type { AssetKind, CaptureOrigin, Job } from "./api";

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

  /** With `wait`, the server holds the request until the job settles or its wait cap passes. */
  async capture(url: string, origin: CaptureOrigin, wait: boolean): Promise<Job> {
    const response = await this.request("POST", `/capture${wait ? "?wait=1" : ""}`, { url, origin });
    return (response.json as { job: Job }).job;
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

  async delivered(id: string): Promise<void> {
    await this.request("POST", `/jobs/${id}/delivered`);
  }
}
