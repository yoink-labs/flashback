import { createRoot } from 'react-dom/client';
import { BrowserRouter, Link, Route, Routes } from 'react-router-dom';
import { Home } from './screens/Home';
import { JoinScreen } from './screens/Join';
import { RoomScreen } from './screens/Room';
import { SignInScreen } from './screens/SignIn';
import { loadClerk } from './clerk';
import './style.css';

// Start loading Clerk in the background. Guests never wait on it.
void loadClerk();

function App() {
  return (
    <BrowserRouter>
      <header className="top">
        <Link to="/" className="brand" aria-label="Flashback home">
          <img src="/icon.svg" alt="" width={32} height={32} />
          <span>Flashback</span>
        </Link>
      </header>
      <Routes>
        <Route path="/" element={<Home />} />
        {/* Guest join path: code + nickname, no account. */}
        <Route path="/join/:code" element={<JoinScreen />} />
        <Route path="/join" element={<JoinScreen />} />
        {/* Optional Clerk sign-in path. */}
        <Route path="/sign-in" element={<SignInScreen />} />
        <Route path="/room/:code" element={<RoomScreen />} />
        <Route path="*" element={<Home />} />
      </Routes>
      <footer className="foot">
        Free and open source by <a href="https://yoinklabs.dev">Yoink Labs</a> ·{' '}
        <a href="https://github.com/yoink-labs/flashback">GitHub</a> · Photos and videos are deleted after each round.
      </footer>
    </BrowserRouter>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
