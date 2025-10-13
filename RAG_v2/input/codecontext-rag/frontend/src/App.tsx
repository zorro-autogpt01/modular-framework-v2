import { Link, Route, Routes, Navigate } from 'react-router-dom'
import Repositories from './pages/Repositories'
import Recommendations from './pages/Recommendations'
import Dependencies from './pages/Dependencies'
import Impact from './pages/Impact'
import './styles.css'

export default function App() {
  return (
    <div className="container">
      <nav className="nav">
        <div className="brand">CodeContext RAG</div>
        <div className="links">
          <Link to="/repositories">Repositories</Link>
          <Link to="/recommendations">Recommendations</Link>
          <Link to="/dependencies">Dependencies</Link>
          <Link to="/impact">Impact</Link>
        </div>
      </nav>
      <main>
        <Routes>
          <Route path="/repositories" element={<Repositories />} />
          <Route path="/recommendations" element={<Recommendations />} />
          <Route path="/dependencies" element={<Dependencies />} />
          <Route path="/impact" element={<Impact />} />
          <Route path="*" element={<Navigate to="/repositories" replace />} />
        </Routes>
      </main>
      <footer className="footer">
        <small>API: {import.meta.env.VITE_API_BASE || 'http://localhost:8000'}</small>
      </footer>
    </div>
  )
}
