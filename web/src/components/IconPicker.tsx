import SearchIcon from '@mui/icons-material/Search';
import CloseIcon from '@mui/icons-material/Close';
import EditIcon from '@mui/icons-material/Edit';
import DeleteIcon from '@mui/icons-material/Delete';
import StarIcon from '@mui/icons-material/Star';
import StarBorderIcon from '@mui/icons-material/StarBorder';
import {
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  InputAdornment,
  Tab,
  Tabs,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import { useEffect, useState } from 'react';
import { VectorIconImporter } from './VectorIconImporter';
import { loadCustomIcons, customIconId, customIconName, deleteCustomIcon, type CustomIcon } from '../widgets/utils/customIcons';
import { UniversalIcon } from '../widgets/components/UniversalIcon';
import { listCollectionIcons, searchIcons } from '../widgets/utils/iconCache';

interface IconPickerProps {
  value: string;
  onChange: (value: string) => void;
  label?: string;
}

const COLLECTIONS = [
  { id: 'custom', label: 'Custom' },
  { id: 'mdi', label: 'Material Design' },
  { id: 'fa6-solid', label: 'Font Awesome' },
  { id: 'material-symbols', label: 'Material Symbols' },
  { id: 'bi', label: 'Bootstrap' },
  { id: 'ion', label: 'Ionicons' },
];

function readList(key: string): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(key) || '[]');
    return Array.isArray(value) ? value.filter(item => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function writeList(key: string, values: string[]): void {
  localStorage.setItem(key, JSON.stringify(values.slice(0, 50)));
}

export function IconPicker({ value, onChange, label = 'Icon' }: IconPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [collection, setCollection] = useState('mdi');
  const [icons, setIcons] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [recent, setRecent] = useState<string[]>([]);
  const [favorites, setFavorites] = useState<string[]>([]);
  const [activeTab, setActiveTab] = useState<'icons' | 'recent' | 'favorites'>('icons');
  const [draft, setDraft] = useState(value);
  const [importerOpen, setImporterOpen] = useState(false);
  const [importerInitial, setImporterInitial] = useState<CustomIcon | undefined>();

  useEffect(() => {
    if (!open) return;
    setDraft(value);
    setRecent(readList('core-icon-recent'));
    setFavorites(readList('core-icon-favorites'));
  }, [open, value]);

  useEffect(() => {
    if (!open || activeTab !== 'icons') return;
    let cancelled = false;
    setLoading(true);
    const load = collection === 'custom'
      ? Promise.resolve(loadCustomIcons().map(icon => customIconId(icon.name)))
      : query.trim()
        ? searchIcons(query.trim(), collection, 80)
        : listCollectionIcons(collection, 0, 120);
    load.then(result => {
      if (!cancelled) setIcons(result);
    }).catch(() => {
      if (!cancelled) setIcons([]);
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [open, activeTab, collection, query]);

  const choose = (icon: string) => {
    setDraft(icon);
    const nextRecent = [icon, ...recent.filter(item => item !== icon)];
    setRecent(nextRecent);
    writeList('core-icon-recent', nextRecent);
  };

  const createCustom = () => {
    setImporterInitial(undefined);
    setImporterOpen(true);
  };

  const editCustom = (icon: string, event: React.MouseEvent) => {
    event.stopPropagation();
    const custom = loadCustomIcons().find(item => customIconId(item.name) === icon);
    if (!custom) return;
    setImporterInitial(custom);
    setImporterOpen(true);
  };

  const removeCustom = (icon: string, event: React.MouseEvent) => {
    event.stopPropagation();
    const name = customIconName(icon);
    if (!window.confirm(`Delete custom icon "${name}"? This can't be undone.`)) return;
    deleteCustomIcon(name);
    setIcons(loadCustomIcons().map(item => customIconId(item.name)));
    if (draft === icon) setDraft('');
    if (favorites.includes(icon)) {
      const next = favorites.filter(item => item !== icon);
      setFavorites(next);
      writeList('core-icon-favorites', next);
    }
    if (recent.includes(icon)) {
      const next = recent.filter(item => item !== icon);
      setRecent(next);
      writeList('core-icon-recent', next);
    }
  };

  const toggleFavorite = (icon: string, event: React.MouseEvent) => {
    event.stopPropagation();
    const next = favorites.includes(icon)
      ? favorites.filter(item => item !== icon)
      : [icon, ...favorites];
    setFavorites(next);
    writeList('core-icon-favorites', next);
  };

  const displayed = activeTab === 'recent' ? recent : activeTab === 'favorites' ? favorites : icons;

  return (
    <>
      <Button
        variant="outlined"
        size="small"
        fullWidth
        onClick={() => setOpen(true)}
        startIcon={value ? <UniversalIcon icon={value} size={20} /> : undefined}
        sx={{ justifyContent: 'flex-start', textTransform: 'none', minHeight: 40 }}
      >
        {value || `Select ${label}`}
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} maxWidth="md" fullWidth>
        <DialogTitle sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          Select {label}
          <IconButton size="small" onClick={() => setOpen(false)} aria-label="Close icon picker">
            <CloseIcon />
          </IconButton>
        </DialogTitle>
        <DialogContent dividers>
          <TextField
            fullWidth
            size="small"
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder="Search icons"
            slotProps={{ input: { startAdornment: <InputAdornment position="start"><SearchIcon fontSize="small" /></InputAdornment> } }}
            sx={{ mb: 1.5 }}
          />
          <Tabs value={activeTab} onChange={(_, next) => setActiveTab(next)} variant="scrollable" sx={{ mb: 1 }}>
            <Tab value="icons" label="Icons" />
            <Tab value="recent" label="Recent" />
            <Tab value="favorites" label="Favorites" />
          </Tabs>
          {activeTab === 'icons' && (
            <Box sx={{ display: 'flex', gap: 0.75, flexWrap: 'wrap', mb: 1.5 }}>
              {COLLECTIONS.map(item => (
                <Chip key={item.id} size="small" label={item.label} color={collection === item.id ? 'primary' : 'default'} onClick={() => setCollection(item.id)} />
              ))}
            </Box>
          )}
          {activeTab === 'icons' && collection === 'custom' && (
              <Button size="small" variant="contained" onClick={createCustom} sx={{ mb: 1.5 }}>
              Import vector icon
            </Button>
          )}
          {draft && (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, p: 1, mb: 1.5, border: 1, borderColor: 'divider', borderRadius: 1 }}>
              <UniversalIcon icon={draft} size={28} />
              <Typography variant="caption" sx={{ fontFamily: 'monospace' }}>{draft}</Typography>
            </Box>
          )}
          {loading ? (
            <Box sx={{ display: 'flex', justifyContent: 'center', p: 5 }}><CircularProgress size={28} /></Box>
          ) : displayed.length === 0 ? (
            <Typography variant="body2" color="text.secondary" sx={{ p: 2 }}>No icons found.</Typography>
          ) : (
            <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(92px, 1fr))', gap: 0.75, maxHeight: 440, overflowY: 'auto' }}>
              {displayed.map(icon => (
                <Tooltip key={icon} title={icon}>
                  <Box onClick={() => choose(icon)} sx={{ position: 'relative', minHeight: 72, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 0.5, cursor: 'pointer', border: 1, borderColor: draft === icon ? 'primary.main' : 'divider', borderRadius: 1, '&:hover': { bgcolor: 'action.hover' } }}>
                    <UniversalIcon icon={icon} size={28} />
                    <Typography variant="caption" noWrap sx={{ maxWidth: '90%', fontSize: 10 }}>{icon.split(':').slice(1).join(':')}</Typography>
                    {collection === 'custom' && (
                      <>
                        <IconButton size="small" onClick={event => editCustom(icon, event)} sx={{ position: 'absolute', top: 1, left: 1, p: 0.25 }} aria-label="Edit custom icon">
                          <EditIcon sx={{ fontSize: 15 }} />
                        </IconButton>
                        <IconButton size="small" onClick={event => removeCustom(icon, event)} sx={{ position: 'absolute', bottom: 1, left: 1, p: 0.25 }} aria-label="Delete custom icon">
                          <DeleteIcon sx={{ fontSize: 15, color: 'error.main' }} />
                        </IconButton>
                      </>
                    )}
                    <IconButton size="small" onClick={event => toggleFavorite(icon, event)} sx={{ position: 'absolute', top: 1, right: 1, p: 0.25 }} aria-label="Toggle favorite">
                      {favorites.includes(icon) ? <StarIcon sx={{ fontSize: 15, color: 'warning.main' }} /> : <StarBorderIcon sx={{ fontSize: 15 }} />}
                    </IconButton>
                  </Box>
                </Tooltip>
              ))}
            </Box>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setOpen(false)}>Cancel</Button>
          <Button variant="contained" disabled={!draft} onClick={() => { onChange(draft); setOpen(false); }}>Use icon</Button>
        </DialogActions>
      </Dialog>
      <VectorIconImporter
        open={importerOpen}
        initial={importerInitial}
        onClose={() => setImporterOpen(false)}
        onSaved={icon => {
          choose(icon);
          if (collection === 'custom') setIcons(loadCustomIcons().map(item => customIconId(item.name)));
          setImporterOpen(false);
        }}
      />
    </>
  );
}
