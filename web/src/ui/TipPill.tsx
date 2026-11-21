// "♥ Tip the devs": the shared Yoink Labs tip link. Flashback is free with
// nothing locked; tipping happens in the iPhone app, and yoinklabs.dev/tip
// explains where. Nothing is paid on the web.

export const TIP_URL = 'https://yoinklabs.dev/tip';

export function HeartIcon({ size = 14 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden="true">
      <path d="M12 21.2l-1.4-1.3C5.4 15.2 2 12.1 2 8.3 2 5.2 4.4 2.8 7.5 2.8c1.7 0 3.4.8 4.5 2.1 1.1-1.3 2.8-2.1 4.5-2.1 3.1 0 5.5 2.4 5.5 5.5 0 3.8-3.4 6.9-8.6 11.6L12 21.2z" />
    </svg>
  );
}

export function TipPill() {
  return (
    <a className="tip-pill" href={TIP_URL} data-testid="tip-the-devs">
      <HeartIcon />
      <span>Tip the devs</span>
    </a>
  );
}
