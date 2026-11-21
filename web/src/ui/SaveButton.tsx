// The download icon on the round's media (reveal and results).
import { useMemo } from 'react';
import { mediaFile, saveFile } from '../save';
import type { MediaEntry } from '../useRoom';
import { DownloadIcon } from './Icons';
import { toast } from './Toast';

export function SaveButton({ entry, round, className = '' }: { entry: MediaEntry | undefined; round: number; className?: string }) {
  const file = useMemo(() => (entry ? mediaFile(entry, round) : null), [entry, round]);

  if (!entry) return null;
  return (
    <button
      type="button"
      className={`round-btn save-btn ${className}`.trim()}
      aria-label={entry.kind === 'video' ? 'Save this video' : 'Save this photo'}
      data-testid="save-media"
      onClick={async () => {
        if (!file) return;
        try {
          if (await saveFile(file)) toast('Saved');
        } catch {
          toast('Could not save that one');
        }
      }}
    >
      <DownloadIcon />
    </button>
  );
}
