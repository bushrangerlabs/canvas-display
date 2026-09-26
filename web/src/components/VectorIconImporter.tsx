import CloseIcon from '@mui/icons-material/Close';
import UploadFileIcon from '@mui/icons-material/UploadFile';
import { Alert, Button, Dialog, DialogActions, DialogContent, DialogTitle, IconButton, Stack, TextField, Typography } from '@mui/material';
import { useEffect, useState } from 'react';
import { customIconId, loadCustomIcons, saveCustomIcon, type CustomIcon } from '../widgets/utils/customIcons';

interface VectorIconImporterProps {
  open: boolean;
  initial?: CustomIcon;
  onClose: () => void;
  onSaved: (id: string) => void;
}

function normalizeSvg(source: string): string {
  const document = new DOMParser().parseFromString(source, 'image/svg+xml');
  const svg = document.documentElement;
  if (svg.nodeName.toLowerCase() !== 'svg' || document.querySelector('parsererror')) throw new Error('Please provide a valid SVG file or SVG markup.');
  svg.querySelectorAll('script, foreignObject, iframe, object, embed').forEach(element => element.remove());
  svg.querySelectorAll('*').forEach(element => {
    [...element.attributes].forEach(attribute => {
      if (attribute.name.toLowerCase().startsWith('on') || attribute.name.toLowerCase() === 'href' || attribute.name.toLowerCase() === 'xlink:href') element.removeAttribute(attribute.name);
    });
  });
  const viewBox = svg.getAttribute('viewBox');
  if (!viewBox) {
    const width = Number.parseFloat(svg.getAttribute('width') || '24');
    const height = Number.parseFloat(svg.getAttribute('height') || '24');
    svg.setAttribute('viewBox', `0 0 ${Number.isFinite(width) && width > 0 ? width : 24} ${Number.isFinite(height) && height > 0 ? height : 24}`);
  }
  svg.removeAttribute('width');
  svg.removeAttribute('height');
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', '100%');
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  svg.setAttribute('fill', 'currentColor');
  return new XMLSerializer().serializeToString(svg);
}

export function VectorIconImporter({ open, initial, onClose, onSaved }: VectorIconImporterProps) {
  const [name, setName] = useState('my-icon');
  const [source, setSource] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setName(initial?.name || 'my-icon');
    setSource(initial?.svg || '');
    setError('');
  }, [open, initial]);

  const readFile = (file?: File) => {
    if (!file) return;
    if (file.type && file.type !== 'image/svg+xml' && !file.name.toLowerCase().endsWith('.svg')) {
      setError('Choose an SVG vector file.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setSource(String(reader.result || ''));
    reader.onerror = () => setError('The SVG file could not be read.');
    reader.readAsText(file);
  };

  const save = () => {
    try {
      const cleanName = name.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '');
      if (!cleanName) throw new Error('Enter an icon name.');
      const svg = normalizeSvg(source);
      const now = new Date().toISOString();
      const existing = loadCustomIcons().find(icon => icon.name === cleanName);
      saveCustomIcon({ name: cleanName, svg, createdAt: existing?.createdAt || now, updatedAt: now });
      onSaved(customIconId(cleanName));
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The SVG could not be imported.');
    }
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        Import vector icon
        <IconButton size="small" onClick={onClose} aria-label="Close vector importer"><CloseIcon /></IconButton>
      </DialogTitle>
      <DialogContent dividers>
        <Stack spacing={1.5}>
          <TextField size="small" label="Icon name" value={name} onChange={event => setName(event.target.value)} helperText="Letters, numbers, and hyphens only" />
          <Button component="label" variant="outlined" startIcon={<UploadFileIcon />}>
            Choose SVG file
            <input hidden type="file" accept="image/svg+xml,.svg" onChange={event => readFile(event.target.files?.[0])} />
          </Button>
          <TextField multiline minRows={7} maxRows={14} label="Or paste SVG markup" value={source} onChange={event => setSource(event.target.value)} placeholder={'<svg viewBox="0 0 24 24">...</svg>'} />
          {error && <Alert severity="error">{error}</Alert>}
          <Typography variant="caption" color="text.secondary">The vector is fitted to the icon box, keeps its aspect ratio, and uses the selected icon color at render time.</Typography>
        </Stack>
      </DialogContent>
      <DialogActions><Button onClick={onClose}>Cancel</Button><Button variant="contained" onClick={save} disabled={!source.trim() || !name.trim()}>Import icon</Button></DialogActions>
    </Dialog>
  );
}
