import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router';
import { useState, useEffect } from 'react';
import Login from '@/pages/Login';
import Register from '@/pages/Register';
import Dashboard from '@/pages/Dashboard';
import Admin from '@/pages/Admin';
import Settings from '@/pages/Settings';
import { OfflineNotification } from '@/components/OfflineNotification';
import { isAdmin, setUser, setSettings, removeUser } from '@/utils/auth';
import { auth, serverConfig } from '@/utils/api';
import { applyTheme, getThemePreference } from '@/utils/theme';

function App() {
  const [isAuth, setIsAuth] = useState(false);
  const [loading, setLoading] = useState(true);
  const [registrationEnabled, setRegistrationEnabled] = useState(true);

  useEffect(() => {
    applyTheme(getThemePreference());

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleSystemThemeChange = () => applyTheme(getThemePreference());
    mediaQuery.addEventListener('change', handleSystemThemeChange);

    const configPromise = serverConfig.get()
      .then((cfg) => setRegistrationEnabled(cfg.registration_enabled))
      .catch(() => { /* keep default (enabled) if config fetch fails */ });

    // Always validate session against the server — the cookie is the source
    // of truth. localStorage may have been cleared while the session is still
    // valid (e.g. storage eviction, browser updates, cross-tab logout race).
    const authPromise = auth.me()
      .then((response) => {
        setUser(response.user);
        setSettings(response.settings);
        applyTheme(response.settings.theme as 'system' | 'light' | 'dark');
        setIsAuth(true);
      })
      .catch(() => {
        removeUser();
        setIsAuth(false);
      });

    Promise.all([configPromise, authPromise]).finally(() => {
      setLoading(false);
    });

    return () => mediaQuery.removeEventListener('change', handleSystemThemeChange);
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
            element={!isAuth ? <Login onLogin={() => setIsAuth(true)} registrationEnabled={registrationEnabled} /> : <Navigate to="/" />} 
          />
          <Route 
            path="/register" 
            element={!isAuth && registrationEnabled ? <Register onRegister={() => setIsAuth(true)} /> : <Navigate to={isAuth ? "/" : "/login"} />} 
          />
          <Route element={isAuth ? <Dashboard onLogout={() => setIsAuth(false)} /> : <Navigate to="/login" />}>
            <Route index element={null} />
            <Route path="notes/:noteId" element={null} />
          </Route>
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