// Optional sign-in with the shared Yoink Labs Clerk instance (same as Split).
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { loadClerk, useClerk } from '../clerk';

export function SignInScreen() {
  const node = useRef<HTMLDivElement>(null);
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const clerk = useClerk();
  const [failed, setFailed] = useState(false);
  const back = params.get('return')?.startsWith('/') ? params.get('return')! : '/';

  useEffect(() => {
    if (clerk.user) navigate(back, { replace: true });
  }, [clerk.user, back, navigate]);

  useEffect(() => {
    const el = node.current!;
    let mounted = false;
    void loadClerk().then((c) => {
      if (!c) return setFailed(true);
      c.mountSignIn(el, { routing: 'virtual', fallbackRedirectUrl: back, signUpFallbackRedirectUrl: back });
      mounted = true;
    });
    return () => {
      if (mounted) window.Clerk?.unmountSignIn(el);
    };
  }, [back]);

  return (
    <main className="auth">
      <p className="hint">
        Signing in is optional. <Link to={back}>Continue as a guest</Link>
      </p>
      {failed && <p className="error">Sign-in could not load. You can still play as a guest.</p>}
      <div ref={node} />
    </main>
  );
}
