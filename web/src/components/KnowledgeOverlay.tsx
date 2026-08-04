/**
 * KnowledgeOverlay — polls /api/knowledge-card/latest and auto-shows a prominent
 * fullscreen-ish card whenever the AI answers a general knowledge question.
 * Always mounted in SceneDisplayPage — no pre-placed widget required.
 * Auto-dismisses after 30 s or when a new voice turn starts.
 */

import { useEffect, useRef, useState } from 'react';
import { Box, Fade, IconButton, Typography, Chip } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import AutoStoriesIcon from '@mui/icons-material/AutoStories';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';

interface KnowledgeCard {
  title: string;
  body: string;
  source_url?: string;
  source_label?: string;
  image_url?: string;
  show_url?: string;
  timestamp: string;
}

export default function KnowledgeOverlay() {
  const [card, setCard] = useState<KnowledgeCard | null>(null);
  const [visible, setVisible] = useState(false);
  const lastTimestamp = useRef('');
  const dismissTimer = useRef<number | null>(null);
  const pollRef = useRef<number | null>(null);

  const dismiss = () => {
    setVisible(false);
    setTimeout(() => setCard(null), 400);
    if (dismissTimer.current) window.clearTimeout(dismissTimer.current);
  };

  const scheduleDismiss = () => {
    if (dismissTimer.current) window.clearTimeout(dismissTimer.current);
    dismissTimer.current = window.setTimeout(dismiss, 30_000);
  };

  useEffect(() => {
    let stopped = false;

    const poll = async () => {
      try {
        const res = await fetch('/api/knowledge-card/latest', { cache: 'no-store' });
        if (!res.ok) return;
        const data = await res.json();
        if (data?.empty || !data?.timestamp) return;
        if (data.timestamp !== lastTimestamp.current) {
          lastTimestamp.current = data.timestamp;
          setCard(data as KnowledgeCard);
          setVisible(true);
          scheduleDismiss();
        }
      } catch {
        // silently ignore poll errors
      } finally {
        if (!stopped) pollRef.current = window.setTimeout(poll, 3_000);
      }
    };

    void poll();
    return () => {
      stopped = true;
      if (pollRef.current) window.clearTimeout(pollRef.current);
      if (dismissTimer.current) window.clearTimeout(dismissTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!card) return null;

  return (
    <Fade in={visible} timeout={400}>
      <Box
        sx={{
          position: 'fixed',
          bottom: 80,       // sit above VoiceStateOverlay
          left: '50%',
          transform: 'translateX(-50%)',
          width: { xs: '96vw', sm: '72vw', md: '56vw' },
          maxWidth: 820,
          maxHeight: '55vh',
          zIndex: 3100,
          borderRadius: 3,
          bgcolor: 'rgba(10,10,25,0.94)',
          border: '1px solid rgba(99,179,237,0.35)',
          backdropFilter: 'blur(16px)',
          boxShadow: '0 8px 40px rgba(0,0,0,0.7)',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {/* Header */}
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 2.5, pt: 2, pb: 1 }}>
          <AutoStoriesIcon sx={{ color: '#63b3ed', fontSize: 20 }} />
          <Typography
            variant="subtitle1"
            sx={{ flex: 1, fontWeight: 600, color: '#e2e8f0', fontSize: '1rem', lineHeight: 1.3 }}
          >
            {card.title}
          </Typography>
          {card.source_label && (
            <Chip
              label={card.source_label}
              size="small"
              sx={{ bgcolor: 'rgba(99,179,237,0.15)', color: '#90cdf4', height: 20, fontSize: '0.65rem' }}
            />
          )}
          <IconButton size="small" onClick={dismiss} sx={{ color: '#718096', ml: 0.5 }}>
            <CloseIcon fontSize="small" />
          </IconButton>
        </Box>

        {/* Body */}
        <Box sx={{ px: 2.5, pb: card.show_url ? 1 : 2, overflowY: 'auto', flex: 1 }}>
          <Typography
            variant="body2"
            sx={{ color: '#cbd5e0', lineHeight: 1.7, fontSize: '0.9rem', whiteSpace: 'pre-wrap' }}
          >
            {card.body}
          </Typography>
          {card.source_url && !card.show_url && (
            <Typography
              component="a"
              href={card.source_url}
              target="_blank"
              rel="noopener noreferrer"
              sx={{ display: 'inline-block', mt: 1, fontSize: '0.75rem', color: '#63b3ed', textDecoration: 'none', '&:hover': { textDecoration: 'underline' } }}
            >
              {card.source_url}
            </Typography>
          )}
        </Box>

        {/* Open in browser button if show_url present */}
        {card.show_url && (
          <Box sx={{ px: 2.5, pb: 1.5, display: 'flex', justifyContent: 'flex-end' }}>
            <Chip
              icon={<OpenInNewIcon sx={{ fontSize: '0.9rem !important' }} />}
              label="Open source"
              size="small"
              clickable
              onClick={() => window.open(card.show_url!, '_blank')}
              sx={{ bgcolor: 'rgba(99,179,237,0.15)', color: '#90cdf4', cursor: 'pointer' }}
            />
          </Box>
        )}

        {/* Dismiss progress bar */}
        <Box
          sx={{
            height: 3,
            background: 'linear-gradient(90deg,#63b3ed,#9f7aea)',
            animation: 'knowledgeDismiss 30s linear forwards',
            '@keyframes knowledgeDismiss': { from: { width: '100%' }, to: { width: '0%' } },
          }}
        />
      </Box>
    </Fade>
  );
}
