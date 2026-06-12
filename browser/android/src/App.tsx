import React, { useEffect, useState } from 'react';
import { createTheme, ThemeProvider, CssBaseline } from '@mui/material';
import { loadConfig, type AppConfig } from './store/config';
import SettingsScreen from './screens/SettingsScreen';
import KioskScreen from './screens/KioskScreen';

const darkTheme = createTheme({ palette: { mode: 'dark' } });

export default function App() {
  const [config, setConfig] = useState<AppConfig | null | 'loading'>('loading');

  useEffect(() => {
    loadConfig()
      .then(setConfig)
      .catch(() => setConfig(null)); // store error → show settings
  }, []);

  if (config === 'loading') {
    return null; // black screen while reading config
  }

  return (
    <ThemeProvider theme={darkTheme}>
      <CssBaseline />
      {!config ? (
        <SettingsScreen onSaved={setConfig} />
      ) : (
        <KioskScreen config={config} onResetConfig={() => setConfig(null)} />
      )}
    </ThemeProvider>
  );
}
