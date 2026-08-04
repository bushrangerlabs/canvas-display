/**
 * VoiceStateOverlay — polls /api/voice/state and shows a floating overlay on the display:
 *   - listening: animated mic indicator
 *   - processing: thinking spinner
 *   - done: transcript + reply summary + 👍/👎 feedback buttons (auto-hides after 12s)
 *   - error: red indicator with message (auto-hides after 6s)
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Box, IconButton, Typography, Fade } from '@mui/material';
import ThumbUpIcon from '@mui/icons-material/ThumbUp';
import ThumbDownIcon from '@mui/icons-material/ThumbDown';
import MicIcon from '@mui/icons-material/Mic';
import PsychologyIcon from '@mui/icons-material/Psychology';
import ErrorOutlineIcon from '@mui/icons-material/Error';

interface VoiceDisplayState {
  status:      'idle' | 'listening' | 'processing' | 'done' | 'error';
  turnId?:     string;
  transcript?: string;
  reply?:      string;
  error?:      string;
  updatedAt:   string;
}

export default function VoiceStateOverlay() {
  const [vstate, setVstate] = useState<VoiceDisplayState | null>(null);
  const [feedbackSent, setFeedbackSent] = useState<1 | -1 | null>(null);
  const lastUpdatedAt = useRef('');
  const pollRef = useRef<number | null>(null);

  useEffect(() => {
    let stopped = false;
    const poll = async () => {
      try {
        const res = await fetch('/api/voice/state', { cache: 'no-store' });
        if (!res.ok) return;
        const data: VoiceDisplayState = await res.json();
        if (data.updatedAt !== lastUpdatedAt.current) {
          lastUpdatedAt.current = data.updatedAt;
          setVstate(data);
          if (data.status === 'done' || data.status === 'idle') {
            setFeedbackSent(null);
          }
        }
      } catch { /* ignore */ }
      if (!stopped) pollRef.current = window.setTimeout(poll, 1_000);
    };
    void poll();
    return () => {
      stopped = true;
      if (pollRef.current !== null) window.clearTimeout(pollRef.current);
    };
  }, []);

  const sendFeedback = useCallback(async (rating: 1 | -1) => {
    if (!vstate?.turnId || feedbackSent !== null) return;
    setFeedbackSent(rating);
    try {
      await fetch('/api/voice/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ turnId: vstate.turnId, rating }),
      });
    } catch { /* ignore */ }
  }, [vstate?.turnId, feedbackSent]);

  if (!vstate || vstate.status === 'idle') return null;

  return (
    <Fade in={true}>
      <Box sx={{
        position: 'fixed',
        bottom: 32,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 9999,
        minWidth: 280,
        maxWidth: 480,
        bgcolor: 'rgba(10,10,18,0.92)',
        border: '1px solid rgba(255,255,255,0.12)',
        borderRadius: 3,
        p: 2,
        backdropFilter: 'blur(8px)',
        boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
        display: 'flex',
        flexDirection: 'column',
        gap: 1,
      }}>
        {/* Listening */}
        {vstate.status === 'listening' && (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
            <MicIcon sx={{ color: '#4fc3f7', fontSize: 28, animation: 'pulse 1s ease-in-out infinite' }} />
            <Typography sx={{ color: '#e0e0e0', fontSize: 15 }}>Listening…</Typography>
            <style>{`@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }`}</style>
          </Box>
        )}

        {/* Processing */}
        {vstate.status === 'processing' && (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
            <PsychologyIcon sx={{ color: '#ce93d8', fontSize: 28, animation: 'spin 1.5s linear infinite' }} />
            <Typography sx={{ color: '#e0e0e0', fontSize: 15 }}>Thinking…</Typography>
            <style>{`@keyframes spin { from{transform:rotate(0deg)} to{transform:rotate(360deg)} }`}</style>
          </Box>
        )}

        {/* Done */}
        {vstate.status === 'done' && (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
            {vstate.transcript && (
              <Typography sx={{ color: '#90caf9', fontSize: 13, fontStyle: 'italic' }}>
                "{vstate.transcript}"
              </Typography>
            )}
            {vstate.reply && (
              <Typography sx={{ color: '#e0e0e0', fontSize: 14, lineHeight: 1.4 }} noWrap>
                {vstate.reply.length > 140 ? vstate.reply.slice(0, 137) + '…' : vstate.reply}
              </Typography>
            )}
            <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 0.5, mt: 0.5 }}>
              <IconButton
                size="small"
                onClick={() => void sendFeedback(1)}
                disabled={feedbackSent !== null}
                sx={{ color: feedbackSent === 1 ? '#66bb6a' : 'rgba(255,255,255,0.5)', '&:hover': { color: '#66bb6a' } }}
              >
                <ThumbUpIcon fontSize="small" />
              </IconButton>
              <IconButton
                size="small"
                onClick={() => void sendFeedback(-1)}
                disabled={feedbackSent !== null}
                sx={{ color: feedbackSent === -1 ? '#ef5350' : 'rgba(255,255,255,0.5)', '&:hover': { color: '#ef5350' } }}
              >
                <ThumbDownIcon fontSize="small" />
              </IconButton>
            </Box>
          </Box>
        )}

        {/* Error */}
        {vstate.status === 'error' && (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
            <ErrorOutlineIcon sx={{ color: '#ef5350', fontSize: 28 }} />
            <Typography sx={{ color: '#ef9a9a', fontSize: 14 }}>
              {vstate.error ?? 'Voice request failed'}
            </Typography>
          </Box>
        )}
      </Box>
    </Fade>
  );
}
