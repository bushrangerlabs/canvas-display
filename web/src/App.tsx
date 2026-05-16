import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { ThemeProvider, createTheme, CssBaseline } from '@mui/material';
import NavLayout from './components/NavLayout';
import DashboardPage from './pages/DashboardPage';
import SettingsPage from './pages/SettingsPage';
import PagesPage from './pages/PagesPage';
import LogsPage from './pages/LogsPage';

// When served through HA ingress the path is /api/hassio_ingress/<token>/...
// Extract that prefix as the router basename so React Router sees clean paths.
function getBasename(): string {
  const match = window.location.pathname.match(/^(\/api\/hassio_ingress\/[^/]+)/);
  return match ? match[1] : '';
}

const darkTheme = createTheme({
  palette: {
    mode: 'dark',
    primary: { main: '#6c63ff' },
    secondary: { main: '#ff6584' },
    background: {
      default: '#0d0d1a',
      paper: '#161628',
    },
  },
  typography: {
    fontFamily: '"Inter", "Roboto", sans-serif',
  },
});

export default function App() {
  return (
    <ThemeProvider theme={darkTheme}>
      <CssBaseline />
      <BrowserRouter basename={getBasename()}>
        <NavLayout>
          <Routes>
            <Route path="/" element={<DashboardPage />} />
            <Route path="/pages" element={<PagesPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/logs" element={<LogsPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </NavLayout>
      </BrowserRouter>
    </ThemeProvider>
  );
}
