// Build-time check that both ways into a room exist: guest join (code + nickname,
// no account) and optional Clerk sign-in with the shared Yoink Labs instance.
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const html = read('index.html');
const main = read('src/main.tsx');
const api = read('src/api.ts');
const clerk = read('src/clerk.ts');
const entry = read('src/screens/Entry.tsx');
const signIn = read('src/screens/SignIn.tsx');
const room = read('src/useRoom.ts');

const checks = [
  ['Clerk JS loads from clerk.yoinklabs.dev 5.128.2', /src="https:\/\/clerk\.yoinklabs\.dev\/npm\/@clerk\/clerk-js@5\.128\.2\/dist\/clerk\.browser\.js"/.test(html)],
  ['Shared publishable key is set (live key from Split)', /data-clerk-publishable-key="pk_live_[A-Za-z0-9]+"/.test(html)],
  ['Guest join route /join/:code', main.includes('path="/join/:code"')],
  ['Sign-in route /sign-in', main.includes('path="/sign-in"')],
  ['Room route /room/:code', main.includes('path="/room/:code"')],
  ['Guest create posts a nickname to /v1/rooms', api.includes("enter('/v1/rooms', nickname, signedIn)")],
  ['Guest join posts a nickname to /v1/rooms/:code/join', api.includes('enter(`/v1/rooms/${code}/join`, nickname, signedIn)')],
  ['Guests send no Authorization header', api.includes("...(token ? { Authorization: `Bearer ${token}` } : {})")],
  ['Signed-in players send a Clerk session token', api.includes('signedIn ? await clerkToken() : null') && clerk.includes('session?.getToken()')],
  ['Clerk sign-in is mounted with window.Clerk.mountSignIn', signIn.includes('mountSignIn(')],
  ['Clerk sign-out is available', clerk.includes('signOut()') && entry.includes('signOut()')],
  ['Players can choose guest play even when signed in', entry.includes('Play as a guest instead')],
  ['Room sessions are stored for reconnects', api.includes('localStorage.setItem')],
  ['WebSocket authenticates with the room session subprotocol', room.includes("['flashback.v1', `auth.${token.current}`]")],
  ['No @clerk/clerk-react dependency', !read('package.json').includes('@clerk/clerk-react')],
];

const failed = checks.filter(([, ok]) => !ok);
for (const [name, ok] of checks) console.log(`${ok ? '✓' : '✗'} ${name}`);
if (failed.length) {
  console.error(`\n${failed.length} auth path check(s) failed.`);
  process.exit(1);
}
