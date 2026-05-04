/**
 * NavLayout — persistent sidebar navigation wrapper.
 * Used by all top-level pages (Dashboard, Pages, Settings).
 */
import { type ReactNode } from 'react';
import { Box, List, ListItemButton, ListItemIcon, ListItemText, Divider, Tooltip, Typography } from '@mui/material';
import DashboardIcon from '@mui/icons-material/Dashboard';
import LayersIcon from '@mui/icons-material/Layers';
import SettingsIcon from '@mui/icons-material/Settings';
import { useLocation, useNavigate } from 'react-router-dom';

const NAV_WIDTH = 200;

const NAV_ITEMS = [
  { label: 'Dashboard', path: '/',        icon: <DashboardIcon fontSize="small" /> },
  { label: 'Pages',     path: '/pages',   icon: <LayersIcon    fontSize="small" /> },
  { label: 'Settings',  path: '/settings', icon: <SettingsIcon  fontSize="small" /> },
];

export default function NavLayout({ children }: { children: ReactNode }) {
  const location = useLocation();
  const navigate = useNavigate();

  return (
    <Box sx={{ display: 'flex', height: '100vh', overflow: 'hidden' }}>
      {/* Sidebar */}
      <Box sx={{
        width: NAV_WIDTH,
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        borderRight: 1,
        borderColor: 'divider',
        bgcolor: 'background.paper',
      }}>
        {/* Logo */}
        <Box sx={{ px: 2, py: 1.5, display: 'flex', alignItems: 'center', gap: 1 }}>
          <LayersIcon sx={{ color: 'primary.main', fontSize: 20 }} />
          <Typography variant="subtitle2" sx={{ fontWeight: 700, color: 'primary.main', letterSpacing: 0.5 }}>
            Canvas UI
          </Typography>
        </Box>

        <Divider />

        <List dense disablePadding sx={{ flex: 1, pt: 1 }}>
          {NAV_ITEMS.map(item => {
            const selected = item.path === '/'
              ? location.pathname === '/'
              : location.pathname.startsWith(item.path);
            return (
              <Tooltip key={item.path} title="" placement="right">
                <ListItemButton
                  selected={selected}
                  onClick={() => navigate(item.path)}
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
      </Box>

      {/* Page content */}
      <Box sx={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        {children}
      </Box>
    </Box>
  );
}
