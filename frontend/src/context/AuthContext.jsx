import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import apiClient from '@/lib/apiClient';
import { auth as authEndpoints } from '@/lib/endpoints';

const AuthContext = createContext(null);

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [checking, setChecking] = useState(true);
  const loginCalledRef = React.useRef(false);

  // Check session once on app mount
  useEffect(() => {
    apiClient.get(authEndpoints.me)
      .then(res => {
        setUser(res.data);
        localStorage.setItem('user', JSON.stringify(res.data));
      })
      .catch(() => {
        // Don't override a user that was explicitly set by login() —
        // this prevents a race where the internal check fires before the OAuth
        // cookie is processed but login() has already established a valid session.
        if (!loginCalledRef.current) {
          setUser(null);
          localStorage.removeItem('user');
        }
      })
      .finally(() => setChecking(false));
  }, []);

  const login = useCallback((userData) => {
    loginCalledRef.current = true;
    setUser(userData);
    setChecking(false);
    localStorage.setItem('user', JSON.stringify(userData));
  }, []);

  const logout = useCallback(async () => {
    try { await apiClient.post(authEndpoints.logout); } catch {}
    setUser(null);
    localStorage.removeItem('user');
  }, []);

  return (
    <AuthContext.Provider value={{ user, checking, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
};
