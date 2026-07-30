import React, { useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, useNavigate } from 'react-router-dom';
import Sidebar from './components/Sidebar';
import ChatView from './components/ChatView';

// Mirrors the summary shape returned by GET /api/sessions.
export interface Session {
  id: string;
  prompt: string;
  startedAt: number;
}

function AppLayout() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const navigate = useNavigate();

  useEffect(() => {
    fetch('/api/sessions')
      .then((r) => r.json())
      .then((data) => setSessions(data.sessions ?? []));
  }, []);

  // "New session" doesn't create anything yet — it opens an empty draft view
  // that waits for the user's first message. The run is created only once they
  // send that message (see handleSessionCreated).
  function handleNewSession() {
    navigate('/new');
  }

  // Called by ChatView after the draft's first message creates a real run.
  function handleSessionCreated(session: Session) {
    setSessions((prev) => [session, ...prev]);
    navigate(`/sessions/${session.id}`);
  }

  return (
    <div className="app-layout">
      <aside className="sidebar-panel">
        <Sidebar sessions={sessions} onNewSession={handleNewSession} />
      </aside>
      <main className="main-panel">
        <Routes>
          <Route index element={<div className="empty-state">Select or create a session</div>} />
          <Route path="new" element={<ChatView onSessionCreated={handleSessionCreated} />} />
          <Route path="sessions/:id" element={<ChatView onSessionCreated={handleSessionCreated} />} />
        </Routes>
      </main>
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AppLayout />
    </BrowserRouter>
  );
}
