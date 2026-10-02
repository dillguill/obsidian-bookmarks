// Wire types for the bookmarks-server HTTP API; mirrors harness/src/api.ts.
// Bump API_VERSION in both when the API changes incompatibly.
export const API_VERSION = 1;

export type JobStatus = "pending" | "running" | "done" | "failed" | "delivered";

/** Where a capture was requested from (audit #1: not `source`, which is the URL). */
export type CaptureOrigin = "plugin" | "api" | "shortcut" | "bookmarklet" | "share";

export interface PageMeta {
  /** URL after redirects. */
  finalUrl: string;
  canonical: string | null;
  title: string;
  description: string;
  author: string;
  site: string;
  domain: string;
  published: string;
  image: string;
  favicon: string;
  wordCount: number;
  httpStatus: number | null;
  /** Screenshot was cut at the height cap. */
  truncated: boolean;
}

export interface Job {
  id: string;
  url: string;
  origin: CaptureOrigin;
  status: JobStatus;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  meta: PageMeta | null;
  /** Asset kinds available from `GET /jobs/:id/asset/:kind`. */
  assets: AssetKind[];
  /** File extension of the screenshot asset, when there is one. */
  screenshotExt: "jpg" | "png" | null;
}

export type AssetKind = "screenshot" | "markdown";
