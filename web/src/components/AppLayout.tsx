/**
 * AppLayout — persistent sidebar + top bar for the Canvas Core admin dashboard.
 *
 * Top bar shows a live Core health dot, the server URL, and an admin login /
 * logout button. The sidebar holds the primary navigation.
 */
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import {
  Box, List, ListItemButton, ListItemIcon, ListItemText, Divider, Tooltip,
  Typography, AppBar, Toolbar, IconButton, Chip, Button, CircularProgress,
  Avatar, Drawer, useMediaQuery, useTheme, Stack,
} from '@mui/material';
import DashboardIcon from '@mui/icons-material/Dashboard';
import DevicesIcon from '@mui/icons-material/Devices';
import ScenesIcon from '@mui/icons-material/GridView';
import PagesIcon from '@mui/icons-material/Web';
import EditorIcon from '@mui/icons-material/EditNote';
import IntelligenceIcon from '@mui/icons-material/Psychology';
import SettingsIcon from '@mui/icons-material/Settings';
import LogsIcon from '@mui/icons-material/Terminal';
import MenuIcon from '@mui/icons-material/Menu';
import HubIcon from '@mui/icons-material/Hub';
import AccountTreeIcon from '@mui/icons-material/AccountTree';
import LoginIcon from '@mui/icons-material/Login';
import LogoutIcon from '@mui/icons-material/Logout';
import { useLocation, useNavigate } from 'react-router-dom';
import { coreApi, ApiError } from '../api/client';

const NAV_WIDTH = 220;

const NAV_ITEMS = [
  { label: 'Dashboard',    path: '/',             icon: <DashboardIcon fontSize="small" /> },
  { label: 'Devices',      path: '/devices',      icon: <DevicesIcon fontSize="small" /> },
  { label: 'Scenes',       path: '/scenes',       icon: <ScenesIcon fontSize="small" /> },
  { label: 'Pages',        path: '/pages',        icon: <PagesIcon fontSize="small" /> },
  { label: 'Editor',       path: '/editor',       icon: <EditorIcon fontSize="small" /> },
  { label: 'AI Brain',     path: '/intelligence', icon: <IntelligenceIcon fontSize="small" /> },
  { label: 'Automations',  path: '/flows',        icon: <AccountTreeIcon fontSize="small" /> },
  { label: 'Settings',     path: '/settings',     icon: <SettingsIcon fontSize="small" /> },
  { label: 'Logs',         path: '/logs',         icon: <LogsIcon fontSize="small" /> },
];

export interface SessionInfo {
  username: string;
  role: string;
}

/** Best-effort session probe: call a viewer-read endpoint; 401 ⇒ logged out. */
async function probeSession(): Promise<SessionInfo | null> {
  try {
    const current = await coreApi.session();
    return { username: current.username, role: current.role };
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return null;
    // Network error etc. — assume not logged in.
    return null;
  }
}

export default function AppLayout({ children }: { children: ReactNode }) {
  const location = useLocation();
  const navigate = useNavigate();
  const theme = useTheme();
  const isDesktop = useMediaQuery(theme.breakpoints.up('md'));

  const [coreOk, setCoreOk] = useState<boolean | null>(null);
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [loginOpen, setLoginOpen] = useState(false);

  const refresh = useCallback(async () => {
    const [health, sess] = await Promise.all([
      coreApi.health().then(() => true).catch(() => false),
      probeSession(),
    ]);
    setCoreOk(health);
    setSession(sess);
  }, []);

  useEffect(() => { refresh(); const id = setInterval(refresh, 30_000); return () => clearInterval(id); }, [refresh]);
  useEffect(() => {
    const handleUnauthorized = () => {
      localStorage.removeItem('canvas_core_user');
      setSession(null);
      setLoginOpen(true);
    };
    window.addEventListener('canvas:unauthorized', handleUnauthorized);
    return () => window.removeEventListener('canvas:unauthorized', handleUnauthorized);
  }, []);

  async function handleLogin(username: string, password: string): Promise<void> {
    const res = await coreApi.login(username, password);
    const info: SessionInfo = { username: res.username, role: res.role };
    localStorage.setItem('canvas_core_user', JSON.stringify(info));
    setSession(info);
    setLoginOpen(false);
  }

  async function handleLogout() {
    try { await coreApi.logout(); } catch { /* ignore */ }
    localStorage.removeItem('canvas_core_user');
    setSession(null);
  }

  const serverUrl = typeof window !== 'undefined' ? window.location.origin : '';

  const sidebar = (
    <Box sx={{
      width: NAV_WIDTH,
      flexShrink: 0,
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      bgcolor: 'background.paper',
      borderRight: 1,
      borderColor: 'divider',
    }}>
      <Box sx={{ px: 2, py: 1.5, display: 'flex', alignItems: 'center', gap: 1 }}>
        <HubIcon sx={{ color: 'primary.main', fontSize: 22 }} />
        <Box>
          <Typography variant="subtitle2" sx={{ fontWeight: 700, color: 'primary.main', letterSpacing: 0.5, lineHeight: 1.1 }}>
            Canvas Core
          </Typography>
          <Typography variant="caption" sx={{ color: 'text.secondary', fontSize: 10 }}>
            admin dashboard
          </Typography>
        </Box>
      </Box>
      <Divider />
      <List dense disablePadding sx={{ flex: 1, pt: 1 }}>
        {NAV_ITEMS.map(item => {
          const selected = item.path === '/'
            ? location.pathname === '/'
            : location.pathname.startsWith(item.path);
          return (
            <Tooltip key={item.path} title={item.label} placement="right">
              <ListItemButton
                selected={selected}
                onClick={() => { navigate(item.path); setDrawerOpen(false); }}
                sx={{
                  mx: 1, mb: 0.5, borderRadius: 1,
                  '&.Mui-selected': {
                    bgcolor: 'primary.main',
                    color: '#fff',
                    '& .MuiListItemIcon-root': { color: '#fff' },
                    '&:hover': { bgcolor: 'primary.dark' },
                  },
                }}
              >
                <ListItemIcon sx={{ minWidth: 32 }}>{item.icon}</ListItemIcon>
                <ListItemText primary={item.label} slotProps={{ primary: { sx: { fontSize: 13 } } }} />
              </ListItemButton>
            </Tooltip>
          );
        })}
      </List>
      <Divider />
      <Box sx={{ px: 2, py: 1 }}>
        <Typography variant="caption" sx={{ color: 'text.disabled', fontSize: 10 }}>
          v0.1 · {new Date().getFullYear()}
        </Typography>
      </Box>
    </Box>
  );

  return (
    <Box sx={{ display: 'flex', height: '100vh', overflow: 'hidden' }}>
      {isDesktop ? (
        <Box sx={{ flexShrink: 0 }}>{sidebar}</Box>
      ) : (
        <Drawer open={drawerOpen} onClose={() => setDrawerOpen(false)}>
          {sidebar}
        </Drawer>
      )}

      <Box sx={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        <AppBar position="static" elevation={0} sx={{ bgcolor: 'background.paper', borderBottom: 1, borderColor: 'divider' }}>
          <Toolbar variant="dense" sx={{ gap: 1, minHeight: 48 }}>
            {!isDesktop && (
              <IconButton size="small" edge="start" onClick={() => setDrawerOpen(true)}>
                <MenuIcon fontSize="small" />
              </IconButton>
            )}
            <Stack direction="row" sx={{ alignItems: 'center', gap: 1 }}>
              <Box sx={{
                width: 10, height: 10, borderRadius: '50%',
                bgcolor: coreOk === null ? 'text.disabled' : coreOk ? 'success.main' : 'error.main',
                boxShadow: coreOk ? '0 0 6px rgba(74,222,128,0.7)' : 'none',
              }} />
              <Typography variant="caption" sx={{ color: 'text.secondary', fontFamily: 'monospace' }}>
                {coreOk === null ? 'core: …' : coreOk ? 'core: online' : 'core: offline'}
              </Typography>
            </Stack>
            <Typography variant="caption" sx={{ color: 'text.disabled', ml: 1, fontFamily: 'monospace', display: { xs: 'none', sm: 'block' } }}>
              {serverUrl}
            </Typography>
            <Box sx={{ flex: 1 }} />
            {session ? (
              <>
                <Chip
                  size="small"
                  avatar={<Avatar sx={{ width: 20, height: 20, fontSize: 11, bgcolor: 'primary.main' }}>{session.username.slice(0, 1).toUpperCase()}</Avatar>}
                  label={session.username}
                  variant="outlined"
                  sx={{ fontSize: 12 }}
                />
                <Button size="small" color="inherit" startIcon={<LogoutIcon fontSize="small" />} onClick={handleLogout} sx={{ textTransform: 'none' }}>
                  Logout
                </Button>
              </>
            ) : (
              <Button size="small" variant="outlined" startIcon={<LoginIcon fontSize="small" />} onClick={() => setLoginOpen(true)} sx={{ textTransform: 'none' }}>
                Admin login
              </Button>
            )}
          </Toolbar>
        </AppBar>

        <Box sx={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          {children}
        </Box>
      </Box>

      {loginOpen && (
        <LoginDialog
          onClose={() => setLoginOpen(false)}
          onLogin={handleLogin}
        />
      )}
    </Box>
  );
}

// ── Login dialog (inline to keep the layout self-contained) ──────────────────

import { Dialog, DialogTitle, DialogContent, DialogActions, TextField } from '@mui/material';

function LoginDialog({ onClose, onLogin }: { onClose: () => void; onLogin: (u: string, p: string) => Promise<void> }) {
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await onLogin(username, password);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>Admin login</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <TextField
            label="Username"
            value={username}
            onChange={e => setUsername(e.target.value)}
            autoFocus
            size="small"
          />
          <TextField
            label="Password"
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            size="small"
            onKeyDown={e => { if (e.key === 'Enter') submit(); }}
          />
          {error && <Typography variant="caption" sx={{ color: 'error.main' }}>{error}</Typography>}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} size="small">Cancel</Button>
        <Button onClick={submit} size="small" variant="contained" disabled={busy} startIcon={busy ? <CircularProgress size={14} /> : null}>
          Login
        </Button>
      </DialogActions>
    </Dialog>
  );
}
