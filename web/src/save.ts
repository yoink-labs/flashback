// Save the round's media from the bytes this client already has (§4 of
// docs/MILESTONE3.md). Phones get the share sheet ("Save Image" on iOS);
// everything else downloads a file. Nothing is sent to the server.
import type { MediaEntry } from './useRoom';

const isPhone = () => window.matchMedia?.('(pointer: coarse)').matches ?? false;

/** Builds the file up front, so the tap can open the share sheet without awaiting anything (keeps the user gesture). */
export function mediaFile(entry: MediaEntry, round: number): File {
  const blob = entry.blob;
  const video = entry.kind === 'video';
  const type = blob.type || entry.contentType || (video ? 'video/mp4' : 'image/jpeg');
  return new File([blob], `flashback-round-${round}.${video ? 'mp4' : 'jpg'}`, { type });
}

/** Resolves true when saved (or handed to the share sheet), false if the user backed out. */
export async function saveFile(file: File): Promise<boolean> {
  if (isPhone() && typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return true;
    } catch (error) {
      if ((error as DOMException).name === 'AbortError') return false;
      // Fall through to a download.
    }
  }
  const url = URL.createObjectURL(file);
  const link = document.createElement('a');
  link.href = url;
  link.download = file.name;
  link.rel = 'noopener';
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  return true;
}
