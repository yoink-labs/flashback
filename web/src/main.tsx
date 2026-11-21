import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { Home } from './screens/Home';
import { JoinScreen } from './screens/Join';
import { RoomScreen } from './screens/Room';
import { SignInScreen } from './screens/SignIn';
import { loadClerk } from './clerk';
import { sweepStoredDecks } from './deckStore';
import './style.css';

// Start loading Clerk in the background. Guests never wait on it.
void loadClerk();
// Drop bunches saved for rooms more than six hours ago.
void sweepStoredDecks();

function App() {
  return (
    <BrowserRouter>
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
    </BrowserRouter>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
