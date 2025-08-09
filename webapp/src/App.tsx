import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { useState, useEffect } from 'react';
import Login from '@/pages/Login';
import Register from '@/pages/Register';
import Dashboard from '@/pages/Dashboard';
import Admin from '@/pages/Admin';
import { isAuthenticated, isAdmin } from '@/utils/auth';

function App() {
  const [isAuth, setIsAuth] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setIsAuth(isAuthenticated());
    setLoading(false);
  }, []);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-32 w-32 border-b-2 border-blue-500"></div>
      </div>
    );
  }

  return (
    <Router>
      <div className="min-h-screen bg-gray-50">
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
        </Routes>
      </div>
    </Router>
  );
}

export default App;