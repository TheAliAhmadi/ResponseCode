import { Navigate, NavLink, Route, Routes } from "react-router-dom";
import AdminPage from "./pages/AdminPage";
import ReviewPage from "./pages/ReviewPage";

export default function App() {
  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand-wrap">
          <h1>Pair Reviewer</h1>
          <p>Cloud annotation workspace for focal/candidate event judgments.</p>
        </div>
        <nav className="topnav">
          <NavLink to="/review" className={({ isActive }) => (isActive ? "active" : "")}>Review</NavLink>
          <NavLink to="/admin" className={({ isActive }) => (isActive ? "active" : "")}>Admin</NavLink>
        </nav>
      </header>

      <Routes>
        <Route path="/" element={<Navigate to="/review" replace />} />
        <Route path="/review" element={<ReviewPage />} />
        <Route path="/review/:pair_id" element={<ReviewPage />} />
        <Route path="/admin" element={<AdminPage />} />
        <Route path="*" element={<Navigate to="/review" replace />} />
      </Routes>
    </div>
  );
}
