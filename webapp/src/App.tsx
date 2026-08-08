import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router';
import { useState, useEffect } from 'react';
import Login from '@/pages/Login';
import Register from '@/pages/Register';
import Dashboard from '@/pages/Dashboard';
import Admin from '@/pages/Admin';
import Settings from '@/pages/Settings';
import AuthenticatedLayout from '@/components/AuthenticatedLayout';
import MobileAppHandoff from '@/components/MobileAppHandoff';
import { OfflineNotification } from '@/components/OfflineNotification';
import { ToastProvider } from '@/components/Toast';
import { isAdmin, setUser, setSettings, removeUser } from '@/utils/auth';
import { auth, serverConfig } from '@/utils/api';
import { applyTheme, getThemePreference } from '@/utils/theme';
import { LoginRedirect, PostAuthRedirect } from '@/components/AuthRedirect';
import { VALIDATION, UPLOAD_MAX_BYTES } from '@jot/shared';

function App() {
  const [isAuth, setIsAuth] = useState(false);
  // Signing out deliberately lands on a clean login page rather than one that
  // remembers the page being left — on a shared device the next person to sign
  // in would otherwise be dropped into the last one's note. It has to be App
  // state so it flips in the same render as isAuth: the redirect below is
  // decided during that render, and a flag living elsewhere would race it.
  const [signedOut, setSignedOut] = useState(false);
  const [loading, setLoading] = useState(true);
  const [registrationEnabled, setRegistrationEnabled] = useState(true);
  const [passwordMinLength, setPasswordMinLength] = useState<number>(VALIDATION.PASSWORD_MIN_LENGTH);
  const [uploadMaxBytes, setUploadMaxBytes] = useState<number>(UPLOAD_MAX_BYTES);

  useEffect(() => {
    applyTheme(getThemePreference());

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleSystemThemeChange = () => applyTheme(getThemePreference());
    mediaQuery.addEventListener('change', handleSystemThemeChange);

    const configPromise = serverConfig.get()
      .then((cfg) => {
        setRegistrationEnabled(cfg.registration_enabled);
        setPasswordMinLength(cfg.password_min_length);
        setUploadMaxBytes(cfg.upload_max_bytes);
      })
      .catch(() => { /* keep defaults if config fetch fails */ });

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

  return (
    <>
      {/*
        Above the session gate, and at a position that does not move when
        `loading` flips, so a shared link reaches the mobile app without first
        waiting on auth.me() — and so the handoff is not restarted mid-attempt
        by the remount that changing branches would otherwise cause. It reads
        the entry URL rather than the router, so it needs neither the session
        nor the routes.
      */}
      <MobileAppHandoff />
      {loading ? (
        <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-slate-900">
          <div className="animate-spin rounded-full h-32 w-32 border-b-2 border-blue-500"></div>
        </div>
      ) : (
    <Router>
      <ToastProvider>
      <div className="min-h-screen bg-gray-50 dark:bg-slate-900">
        <OfflineNotification />
        <Routes>
          <Route
            path="/login"
            element={!isAuth ? <Login onLogin={() => setIsAuth(true)} registrationEnabled={registrationEnabled} /> : <PostAuthRedirect />}
          />
          <Route
            path="/register"
            element={!isAuth && registrationEnabled ? <Register onRegister={() => setIsAuth(true)} passwordMinLength={passwordMinLength} /> : (isAuth ? <PostAuthRedirect /> : <Navigate to="/login" />)}
          />
          <Route
            element={
              isAuth
                ? <AuthenticatedLayout onLogout={() => { setIsAuth(false); setSignedOut(true); }} />
                : (signedOut ? <Navigate to="/login" replace /> : <LoginRedirect />)
            }
          >
            <Route element={<Dashboard uploadMaxBytes={uploadMaxBytes} />}>
              <Route index element={null} />
              <Route path="notes/:noteId" element={null} />
              <Route path="new" element={null} />
            </Route>
            <Route
              path="/admin"
              element={isAdmin() ? <Admin passwordMinLength={passwordMinLength} /> : <Navigate to="/" />}
            />
            <Route
              path="/settings"
              element={<Settings passwordMinLength={passwordMinLength} />}
            />
          </Route>
        </Routes>
      </div>
      </ToastProvider>
    </Router>
      )}
    </>
  );
}

export default App;
