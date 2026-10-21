// When a capture doesn't download media, the note points at it where it lives
// instead: the TikTok player for the video, the image's web address for an
// image. "Download media for current note" later swaps these for vault files.

import { fileMarker, TIKTOK_IMAGE_MAX, type CaptureFile, type RenderedNote } from "./api.js";

/** Where a capture's media lives on the web. */
export interface RemoteMedia {
  /** The TikTok player embed, for the video (and a photo post's carousel); empty off TikTok. */
  player: string;
  /** Web address of each image file, by its capture file; missing ones are dropped from the note. */
  images: Partial<Record<CaptureFile, string>>;
}

/** Capture files that are media (downloaded later), not screenshots. */
export const MEDIA_FILES: readonly CaptureFile[] = [
  "image_local",
  "tiktok_thumbnail",
  "tiktok_video",
  ...Array.from({ length: TIKTOK_IMAGE_MAX }, (_, i) => `tiktok_image_${i + 1}` as const),
];

/**
 * Swaps each media file's marker for where the media lives: an embed
 * `![[marker]]` becomes `![](url)`, a link `[[marker]]` and a bare marker become
 * the address. The video becomes the player, however it was written. Media
 * with no address is dropped, with its brackets, so no broken link is left.
 */
export function withRemoteMedia(text: string, media: RemoteMedia): string {
  let out = text;
  for (const kind of MEDIA_FILES) {
    const marker = fileMarker(kind);
    if (!out.includes(marker)) continue;
    const url = kind === "tiktok_video" ? null : media.images[kind];
    const embed = kind === "tiktok_video" ? media.player : url ? `![](${url})` : "";
    const link = kind === "tiktok_video" ? media.player : (url ?? "");
    out = out.split(`![[${marker}]]`).join(embed).split(`[[${marker}]]`).join(link).split(marker).join(link);
  }
  return out;
}

/** The same player twice in a row (from {{tiktok_embed}} and {{tiktok_images}} both) is shown once. */
export function oneTikTokPlayer(text: string, player: string): string {
  if (!player) return text;
  const twice = new RegExp(`(${escape(player)})(\\s*${escape(player)})+`, "g");
  return text.replace(twice, "$1");
}

/** A rendered note with its media pointing at the web; frontmatter values take the bare address. */
export function noteWithRemoteMedia(note: RenderedNote, media: RemoteMedia): RenderedNote {
  return {
    ...note,
    frontmatter: withRemoteMedia(note.frontmatter, { ...media, player: "" }),
    content: oneTikTokPlayer(withRemoteMedia(note.content, media), media.player),
  };
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
