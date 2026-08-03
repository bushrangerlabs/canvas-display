/**
 * Small shared UI helpers used across Core admin pages.
 */
import { type ReactNode } from 'react';
import {
  Box, Typography, Button, CircularProgress, Paper, Stack, Chip,
} from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';

export function PageHeader({
  title,
  subtitle,
  onRefresh,
  loading,
  actions,
}: {
  title: string;
  subtitle?: string;
  onRefresh?: () => void;
  loading?: boolean;
  actions?: ReactNode;
}) {
  return (
    <Box sx={{
      px: 2.5, py: 1.5, borderBottom: 1, borderColor: 'divider',
      bgcolor: 'background.paper', display: 'flex', alignItems: 'center', gap: 1,
      flexShrink: 0,
    }}>
      <Box sx={{ flex: 1 }}>
        <Typography variant="h6" sx={{ fontWeight: 600, fontSize: 16 }}>{title}</Typography>
        {subtitle && <Typography variant="caption" sx={{ color: 'text.secondary' }}>{subtitle}</Typography>}
      </Box>
      {actions}
      {onRefresh && (
        <Button
          size="small"
          startIcon={loading ? <CircularProgress size={12} /> : <RefreshIcon fontSize="small" />}
          onClick={onRefresh}
          disabled={loading}
          sx={{ textTransform: 'none' }}
        >
          Refresh
        </Button>
      )}
    </Box>
  );
}

export function PageBody({ children }: { children: ReactNode }) {
  return (
    <Box sx={{ flex: 1, overflowY: 'auto', p: 3 }}>
      {children}
    </Box>
  );
}

export function Card({ children, sx }: { children: ReactNode; sx?: object }) {
  return <Paper sx={{ p: 2.5, ...sx }}>{children}</Paper>;
}

export function StatCard({ label, value, ok, sub }: { label: string; value: ReactNode; ok?: boolean; sub?: string }) {
  return (
    <Paper sx={{ p: 2.5, flex: 1 }}>
      <Typography variant="caption" color="text.secondary" sx={{ textTransform: 'uppercase', letterSpacing: 0.5 }}>
        {label}
      </Typography>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mt: 0.5 }}>
        {ok === true && <Box sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: 'success.main' }} />}
        {ok === false && <Box sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: 'error.main' }} />}
        <Typography variant="h6" sx={{ fontSize: 18, fontWeight: 600 }}>{value}</Typography>
      </Stack>
      {sub && <Typography variant="caption" color="text.secondary">{sub}</Typography>}
    </Paper>
  );
}

export function ErrorBanner({ error, onRetry }: { error: string; onRetry?: () => void }) {
  return (
    <Paper sx={{ p: 2, mb: 2, borderColor: 'error.main', bgcolor: 'error.main', color: '#fff' }}>
      <Stack direction="row" sx={{ alignItems: 'center', gap: 1 }}>
        <Typography variant="body2" sx={{ flex: 1, color: '#fff' }}>{error}</Typography>
        {onRetry && <Button size="small" variant="outlined" onClick={onRetry} sx={{ color: '#fff', borderColor: '#fff' }}>Retry</Button>}
      </Stack>
    </Paper>
  );
}

export function LoadingBox({ label = 'Loading…' }: { label?: string }) {
  return (
    <Stack direction="row" sx={{ alignItems: 'center', gap: 1, p: 3, justifyContent: 'center' }}>
      <CircularProgress size={16} />
      <Typography variant="body2" color="text.secondary">{label}</Typography>
    </Stack>
  );
}

export function BoolChip({ value, trueLabel = 'yes', falseLabel = 'no' }: { value: boolean; trueLabel?: string; falseLabel?: string }) {
  return <Chip size="small" label={value ? trueLabel : falseLabel} color={value ? 'success' : 'default'} variant={value ? 'filled' : 'outlined'} sx={{ fontSize: 11 }} />;
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function fmtRelative(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso).getTime();
  if (!Number.isFinite(d)) return '—';
  const diff = Date.now() - d;
  if (diff < 60_000) return `${Math.max(1, Math.round(diff / 1000))}s ago`;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return `${Math.round(diff / 86_400_000)}d ago`;
}
