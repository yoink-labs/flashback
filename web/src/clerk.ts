// Optional Clerk sign-in, loaded the same way as Split's web app: clerk-js from
// clerk.yoinklabs.dev with the shared publishable key in index.html. Guests never
// need it, so a failed load only hides the sign-in option.
import { useEffect, useState } from 'react';

export type ClerkUser = { id: string; firstName?: string | null; username?: string | null; fullName?: string | null };
type Clerk = {
  load(): Promise<void>;
  user: ClerkUser | null;
  session: { getToken(): Promise<string | null> } | null;
  addListener(cb: () => void): () => void;
  mountSignIn(el: HTMLElement, options: object): void;
  unmountSignIn(el: HTMLElement): void;
  signOut(): Promise<void>;
};
declare global {
  interface Window {
    Clerk?: Clerk;
  }
}

let loading: Promise<Clerk | null> | null = null;

export function loadClerk(): Promise<Clerk | null> {
  loading ??= (async () => {
    try {
      if (!window.Clerk)
        await new Promise<void>((resolve, reject) => {
          const tag = document.querySelector('script[data-clerk-publishable-key]');
          if (!tag) return reject(new Error('missing'));
          const timeout = setTimeout(() => reject(new Error('timeout')), 15000);
          tag.addEventListener('load', () => (clearTimeout(timeout), resolve()), { once: true });
          tag.addEventListener('error', () => (clearTimeout(timeout), reject(new Error('error'))), { once: true });
        });
      await window.Clerk!.load();
      return window.Clerk!;
    } catch {
      return null;
    }
  })();
  return loading;
}

/** A fresh Clerk session token, or null when signed out or Clerk is unavailable. */
export async function clerkToken(): Promise<string | null> {
  const clerk = await loadClerk();
  return (await clerk?.session?.getToken()) ?? null;
}

export const displayName = (user: ClerkUser | null) => (user?.firstName || user?.username || user?.fullName || '').slice(0, 24);

export type ClerkState = { status: 'loading' | 'ready' | 'unavailable'; user: ClerkUser | null };

export function useClerk(): ClerkState {
  const [state, setState] = useState<ClerkState>({ status: 'loading', user: null });
  useEffect(() => {
    let stop: (() => void) | undefined;
    let active = true;
    void loadClerk().then((clerk) => {
      if (!active) return;
      if (!clerk) return setState({ status: 'unavailable', user: null });
      const sync = () => setState({ status: 'ready', user: clerk.user ? { ...clerk.user } : null });
      sync();
      stop = clerk.addListener(sync);
    });
    return () => {
      active = false;
      stop?.();
    };
  }, []);
  return state;
}

export async function signOut() {
  await (await loadClerk())?.signOut();
}
