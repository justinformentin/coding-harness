import React from "react";
import { NavLink } from "react-router-dom";

interface Session {
  id: string;
  prompt: string;
  startedAt: number;
}

interface SidebarProps {
  sessions: Session[];
  onNewSession: () => void;
}

export default function Sidebar({ sessions, onNewSession }: SidebarProps) {
  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <h2>Sessions</h2>
        <button className="new-session-btn" onClick={onNewSession}>
          + New
        </button>
      </div>
      <ul className="sidebar-session-list">
        {sessions.length === 0 && <li className="no-sessions">No sessions</li>}
        {sessions.map((s) => (
          <li key={s.id}>
            <NavLink
              to={`/sessions/${s.id}`}
              className={({ isActive }) =>
                isActive ? "session-link active" : "session-link"
              }
            >
              <span className="session-name">{s.prompt || s.id}</span>
              <span className="session-date">
                {s.startedAt ? new Date(s.startedAt).toLocaleString() : ""}
              </span>
            </NavLink>
          </li>
        ))}
      </ul>
    </div>
  );
}
