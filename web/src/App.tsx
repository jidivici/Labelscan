import { Router } from 'wouter';

import { AuthProvider } from './auth/AuthContext';
import { ApplicationRoutes } from './router/AppRouter';

export function App() {
  return <Router base="/backoffice"><AuthProvider><ApplicationRoutes /></AuthProvider></Router>;
}
