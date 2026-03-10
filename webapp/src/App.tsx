import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { useState, useEffect } from 'react';
import Login from '@/pages/Login';
import Register from '@/pages/Register';
import Dashboard from '@/pages/Dashboard';
import Admin from '@/pages/Admin';
import Settings from '@/pages/Settings';
import { OfflineNotification } from '@/components/OfflineNotification';
import { isAuthenticated, isAdmin, setUser, setSettings, removeUser } from '@/utils/auth';
import { auth } from '@/utils/api';

function App() {
  const [isAuth, setIsAuth] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!isAuthenticated()) {
      setLoading(false);
      return;
    }
    // Validate session against server to detect expired sessions
    auth.me()
      .then((response) => {
        setUser(response.user);
        setSettings(response.settings);
        setIsAuth(true);
      })
      .catch(() => {
        // 401 is handled by the axios interceptor (clears user, redirects to /login)
        // For other errors, also treat as unauthenticated
        removeUser();
        setIsAuth(false);
      })
      .finally(() => {
        setLoading(false);
      });
  }, []);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-slate-900">
        <div className="animate-spin rounded-full h-32 w-32 border-b-2 border-blue-500"></div>
      </div>
    );
  }

  return (
    <Router>
      <div className="min-h-screen bg-gray-50 dark:bg-slate-900">
        <OfflineNotification />
        <Routes>
          <Route 
            path="/login" 
            element={!isAuth ? <Login onLogin={() => setIsAuth(true)} /> : <Navigate to="/" />} 
          />
          <Route 
            path="/register" 
            element={!isAuth ? <Register onRegister={() => setIsAuth(true)} /> : <Navigate to="/" />} 
          />
          <Route 
            path="/" 
            element={isAuth ? <Dashboard onLogout={() => setIsAuth(false)} /> : <Navigate to="/login" />} 
          />
          <Route
            path="/admin"
            element={isAuth && isAdmin() ? <Admin onLogout={() => setIsAuth(false)} /> : <Navigate to="/" />}
          />
          <Route
            path="/settings"
            element={isAuth ? <Settings onLogout={() => setIsAuth(false)} /> : <Navigate to="/login" />}
          />
        </Routes>
      </div>
    </Router>
  );
}

export default App;