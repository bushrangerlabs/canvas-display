import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { ThemeProvider, createTheme, CssBaseline } from '@mui/material';
import AppLayout from './components/AppLayout';
import DashboardPage from './pages/DashboardPage';
import DevicesPage from './pages/DevicesPage';
import ScenesPage from './pages/ScenesPage';
import PagesPage from './pages/PagesPage';
import EditorPage from './pages/EditorPage';
import IntelligencePage from './pages/IntelligencePage';
import SettingsPage from './pages/SettingsPage';
import LogsPage from './pages/LogsPage';
import AiLogPage from './pages/AiLogPage';
import SceneDisplayPage from './pages/SceneDisplayPage';
import FlowsListPage from './pages/FlowsListPage';
import FlowEditorPage from './pages/FlowEditorPage';
import { WebSocketProvider } from './widgets/providers/WebSocketProvider';
import { syncCustomIconsFromServer } from './widgets/utils/customIcons';
import { useEffect } from 'react';

const darkTheme = createTheme({
  palette: {
    mode: 'dark',
    primary: { main: '#6c63ff' },
    secondary: { main: '#ff6584' },
    background: {
      default: '#0d0d1a',
      paper: '#161628',
    },
    success: { main: '#4ade80' },
    error: { main: '#f28b82' },
    warning: { main: '#fdd663' },
    info: { main: '#6c63ff' },
  },
  typography: {
    fontFamily: '"Inter", "Roboto", system-ui, sans-serif',
  },
  shape: { borderRadius: 8 },
  components: {
    MuiPaper: {
      styleOverrides: {
        root: {
          backgroundImage: 'none',
        },
      },
    },
  },
});

export default function App() {
  // Every client — editor or edge/kiosk display — must see the same custom
  // icon set, so refresh the local cache from the server on every app boot.
  useEffect(() => { void syncCustomIconsFromServer(); }, []);

  return (
    <ThemeProvider theme={darkTheme}>
      <CssBaseline />
      <WebSocketProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/display/scenes/:sceneId" element={<SceneDisplayPage />} />
          <Route path="/flows/:id" element={<FlowEditorPage />} />
          <Route path="*" element={<AppLayout><Routes>
            <Route path="/" element={<DashboardPage />} />
            <Route path="/devices" element={<DevicesPage />} />
            <Route path="/scenes" element={<ScenesPage />} />
            <Route path="/pages" element={<PagesPage />} />
            <Route path="/editor" element={<EditorPage />} />
            <Route path="/intelligence" element={<IntelligencePage />} />
            <Route path="/flows" element={<FlowsListPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/logs" element={<LogsPage />} />
            <Route path="/ai-log" element={<AiLogPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes></AppLayout>} />
        </Routes>
      </BrowserRouter>
      </WebSocketProvider>
    </ThemeProvider>
  );
}
