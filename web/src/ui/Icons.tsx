// Small inline icons. Drawn rather than typed so they look the same in every
// font and on every platform. All share a 24-unit grid and a 2-unit stroke, so
// at one size they read as one set. Default size is 20.
import type { ReactNode } from 'react';

function Stroke({ size = 20, width = 2, children }: { size?: number; width?: number; children: ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={width} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {children}
    </svg>
  );
}

type IconProps = { size?: number };

export function XIcon({ size = 20 }: IconProps) {
  return (
    <Stroke size={size} width={2.2}>
      <path d="M6 6l12 12M18 6L6 18" />
    </Stroke>
  );
}

export function CheckIcon({ size = 16 }: IconProps) {
  return (
    <Stroke size={size} width={3}>
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </Stroke>
  );
}

export function CrossIcon({ size = 14 }: IconProps) {
  return (
    <Stroke size={size} width={3}>
      <path d="M6 6l12 12M18 6L6 18" />
    </Stroke>
  );
}

export function CrownIcon({ size = 12 }: IconProps) {
  return (
    <svg viewBox="0 0 24 16" width={size} height={size * 0.67} fill="currentColor" aria-hidden="true">
      <path d="M2 13h20l-2-9-5 4L12 2 9 8 4 4z" />
    </svg>
  );
}

export function PauseIcon({ size = 20 }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden="true">
      <rect x="6" y="4.5" width="4" height="15" rx="1.4" />
      <rect x="14" y="4.5" width="4" height="15" rx="1.4" />
    </svg>
  );
}

export function PlayIcon({ size = 20 }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden="true">
      <path d="M8 5.2v13.6a1 1 0 001.5.86l11-6.8a1 1 0 000-1.72l-11-6.8A1 1 0 008 5.2z" />
    </svg>
  );
}

export function DownloadIcon({ size = 20 }: IconProps) {
  return (
    <Stroke size={size}>
      <path d="M12 4v11M7 10.5l5 5 5-5" />
      <path d="M5 19.5h14" />
    </Stroke>
  );
}

/** Two arrows chasing each other: a new bunch. */
export function ShuffleIcon({ size = 20 }: IconProps) {
  return (
    <Stroke size={size}>
      <path d="M20 12a8 8 0 01-13.7 5.6M4 12a8 8 0 0113.7-5.6" />
      <path d="M18 2.8v3.9h-3.9M6 21.2v-3.9h3.9" />
    </Stroke>
  );
}

export function PlusIcon({ size = 20 }: IconProps) {
  return (
    <Stroke size={size} width={2.2}>
      <path d="M12 5v14M5 12h14" />
    </Stroke>
  );
}

export function ExpandIcon({ size = 20 }: IconProps) {
  return (
    <Stroke size={size}>
      <path d="M14 4h6v6M10 20H4v-6M20 4l-6.5 6.5M4 20l6.5-6.5" />
    </Stroke>
  );
}

export function ShareIcon({ size = 20 }: IconProps) {
  return (
    <Stroke size={size}>
      <path d="M12 3.5v11M8 7.5l4-4 4 4" />
      <path d="M8 11H6.5A1.5 1.5 0 005 12.5v6A1.5 1.5 0 006.5 20h11a1.5 1.5 0 001.5-1.5v-6a1.5 1.5 0 00-1.5-1.5H16" />
    </Stroke>
  );
}

export function QRIcon({ size = 20 }: IconProps) {
  return (
    <Stroke size={size}>
      <rect x="4" y="4" width="6" height="6" rx="1.2" />
      <rect x="14" y="4" width="6" height="6" rx="1.2" />
      <rect x="4" y="14" width="6" height="6" rx="1.2" />
      <path d="M14 14h2.5v2.5H14zM17.5 17.5H20V20h-2.5zM14 20h1M20 14v1" />
    </Stroke>
  );
}

export function ChevronIcon({ size = 18 }: IconProps) {
  return (
    <Stroke size={size} width={2.2}>
      <path d="M9 6l6 6-6 6" />
    </Stroke>
  );
}

export function BackIcon({ size = 22 }: IconProps) {
  return (
    <Stroke size={size} width={2.2}>
      <path d="M15 5l-7 7 7 7" />
    </Stroke>
  );
}

export function SlidersIcon({ size = 20 }: IconProps) {
  return (
    <Stroke size={size}>
      <path d="M4 7h9M17 7h3M4 17h3M11 17h9" />
      <circle cx="15" cy="7" r="2" />
      <circle cx="9" cy="17" r="2" />
    </Stroke>
  );
}

/** A frame with a plus: pick photos. */
export function PhotoPlusIcon({ size = 32 }: IconProps) {
  return (
    <Stroke size={size} width={1.8}>
      <rect x="3" y="5" width="14" height="14" rx="2.5" />
      <path d="M3 15l4-4 4 4 2-2 4 4" />
      <path d="M19.5 2.5v6M16.5 5.5h6" />
    </Stroke>
  );
}

export function SpeakerOnIcon({ size = 20 }: IconProps) {
  return (
    <Stroke size={size}>
      <path d="M4 9h3l4-4v14l-4-4H4z" />
      <path d="M16 8.5a5 5 0 010 7M18.5 6a8.5 8.5 0 010 12" />
    </Stroke>
  );
}

export function SpeakerOffIcon({ size = 20 }: IconProps) {
  return (
    <Stroke size={size}>
      <path d="M4 9h3l4-4v14l-4-4H4z" />
      <path d="M16 9l5 6M21 9l-5 6" />
    </Stroke>
  );
}

/** The small play triangle on video tiles. */
export function PlayGlyph() {
  return (
    <svg viewBox="0 0 8 10" width="8" height="10" fill="currentColor" aria-hidden="true">
      <path d="M0 0l8 5-8 5z" />
    </svg>
  );
}

// ---- Milestone 4 (docs/MILESTONE4.md §9): one 24-unit set with the rest ----

/** circle.lefthalf.filled: the greyscale streak effect. */
export function GreyscaleIcon({ size = 20 }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="2" />
      <path d="M12 3a9 9 0 010 18z" fill="currentColor" />
    </svg>
  );
}

/** drop.fill: the blur streak effect. */
export function BlurIcon({ size = 20 }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" focusable="false">
      <path d="M12 3.2s6.2 6.5 6.2 10.4a6.2 6.2 0 01-12.4 0C5.8 9.7 12 3.2 12 3.2z" fill="currentColor" />
    </svg>
  );
}

/** scope: the focus round effect. */
export function FocusIcon({ size = 20 }: IconProps) {
  return (
    <Stroke size={size}>
      <circle cx="12" cy="12" r="7.2" />
      <path d="M12 2.5v3.4M12 18.1v3.4M2.5 12h3.4M18.1 12h3.4" />
    </Stroke>
  );
}

/** plus.magnifyingglass: the zoom-out round effect. */
export function ZoomIcon({ size = 20 }: IconProps) {
  return (
    <Stroke size={size}>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="M15.5 15.5L20.5 20.5M10.5 7.7v5.6M7.7 10.5h5.6" />
    </Stroke>
  );
}

/** scissors: a 50/50 charge. */
export function ScissorsIcon({ size = 20 }: IconProps) {
  return (
    <Stroke size={size}>
      <circle cx="6.2" cy="7" r="2.4" />
      <circle cx="6.2" cy="17" r="2.4" />
      <path d="M8.2 8.4L20 18M8.2 15.6L20 6" />
    </Stroke>
  );
}

/** cart.fill: the shop. */
export function CartIcon({ size = 20 }: IconProps) {
  return (
    <Stroke size={size}>
      <path d="M3 4h2.3l2.1 10.4a1.6 1.6 0 001.6 1.3h8.6a1.6 1.6 0 001.6-1.2L21 7.5H6" />
      <circle cx="9.4" cy="19.3" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="17.7" cy="19.3" r="1.5" fill="currentColor" stroke="none" />
    </Stroke>
  );
}

/** equal.circle.fill: Even Split. */
export function EvenSplitIcon({ size = 20 }: IconProps) {
  return (
    <Stroke size={size}>
      <circle cx="12" cy="12" r="9" />
      <path d="M7.6 9.6h8.8M7.6 14.4h8.8" />
    </Stroke>
  );
}

/** die.face.5.fill: Double Down. */
export function DieIcon({ size = 20 }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <rect x="3.5" y="3.5" width="17" height="17" rx="4" />
      <g fill="currentColor" stroke="none">
        <circle cx="8.4" cy="8.4" r="1.5" />
        <circle cx="15.6" cy="8.4" r="1.5" />
        <circle cx="12" cy="12" r="1.5" />
        <circle cx="8.4" cy="15.6" r="1.5" />
        <circle cx="15.6" cy="15.6" r="1.5" />
      </g>
    </svg>
  );
}

/** shield.fill: Shield. */
export function ShieldIcon({ size = 20 }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" focusable="false">
      <path d="M12 2.8l7.4 2.7v5.4c0 4.6-3.1 8.1-7.4 10.3-4.3-2.2-7.4-5.7-7.4-10.3V5.5z" fill="currentColor" />
    </svg>
  );
}

/** The small gold coin used beside shop prices. */
export function CoinIcon({ size = 14 }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="9" fill="currentColor" opacity="0.22" />
      <circle cx="12" cy="12" r="8.4" fill="none" stroke="currentColor" strokeWidth="2" />
      <path d="M12 7.2v9.6M14.4 9.4a3 3 0 00-2.4-1c-1.5 0-2.6.8-2.6 2s1.1 1.8 2.6 2 2.6.9 2.6 2-1.1 2-2.6 2a3 3 0 01-2.4-1" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}
