/**
 * LegacyAutomationsSection
 *
 * Displays existing Routines and Skills with one-click migration to the new
 * visual Flow engine. The old systems still function but are deprecated —
 * this UI guides the user to migrate.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  Alert, Box, Button, Chip, CircularProgress, Divider,
  Paper, Stack, Tooltip, Typography, Accordion,
  AccordionSummary, AccordionDetails,
} from '@mui/material';
import AccountTreeIcon from '@mui/icons-material/AccountTree';
import CallMergeIcon from '@mui/icons-material/CallMerge';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import { useNavigate } from 'react-router-dom';
import {
  coreApi,
  type RoutineRecord, type RoutineRevision,
  type SkillRecord, type SkillRevision,
  type FlowDefinition, type FlowNode, type FlowEdge,
} from '../api/client';
import { randomUUID } from '../utils/uuid';

// ─────────────────────────────────────────────────────────────────────────────
// Migration helpers
// ─────────────────────────────────────────────────────────────────────────────

function routineToFlow(record: RoutineRecord, revision: RoutineRevision): FlowDefinition {
  const def = revision.definition;
  const nodes: FlowNode[] = [];
  const edges: FlowEdge[] = [];

  // Build trigger nodes
  const triggerIds: string[] = [];
  let y = 50;
  for (const trigger of def.triggers ?? []) {
    const id = randomUUID();
    triggerIds.push(id);
    let type: FlowNode['type'] = 'trigger_manual';
    const config: Record<string, unknown> = { ...trigger };
    if (trigger.type === 'voice') {
      type = 'trigger_voice';
      config.phrases = (trigger.phrases as string[] | undefined)?.join('\n') ?? '';
    } else if (trigger.type === 'schedule') {
      type = 'trigger_schedule';
    } else if (trigger.type === 'ha_event') {
      type = 'trigger_ha_state';
    } else if (trigger.type === 'webhook') {
      type = 'trigger_webhook';
    }
    nodes.push({ id, type, position: { x: 50 + triggerIds.length * 220, y }, label: '', config });
    y += 0;
  }
  if (triggerIds.length === 0) {
    const id = randomUUID();
    triggerIds.push(id);
    nodes.push({ id, type: 'trigger_manual', position: { x: 50, y }, label: '', config: {} });
  }

  // Build step nodes
  let prevIds = triggerIds;
  y = 180;
  for (const step of def.steps ?? []) {
    const id = randomUUID();
    let type: FlowNode['type'] = 'action_ha_service';
    const config: Record<string, unknown> = { ...step.config };

    if (step.kind === 'tool') {
      const tool = String(step.config.tool ?? '');
      if (tool.includes('tts') || tool.includes('speak')) {
        type = 'action_tts';
        config.text = step.config.text ?? '';
      } else if (tool.includes('ha') || tool.includes('light') || tool.includes('switch') || tool.includes('climate')) {
        type = 'action_ha_service';
      } else if (tool.includes('scene')) {
        type = 'action_scene';
      } else if (tool.includes('delay') || tool.includes('wait')) {
        type = 'action_delay';
        config.seconds = Number(step.config.duration ?? step.config.seconds ?? 1);
      } else {
        type = 'action_http';
      }
    } else if (step.kind === 'delay') {
      type = 'action_delay';
      config.seconds = Number(step.config.duration_ms ?? 1000) / 1000;
    } else if (step.kind === 'condition') {
      type = 'logic_if_else';
      config.condition = String(step.config.condition ?? '');
    } else if (step.kind === 'result') {
      type = 'action_tts';
      config.text = String(step.config.message ?? step.config.reply ?? '');
    }

    nodes.push({ id, type, position: { x: 200, y }, label: step.id ?? '', config });

    // Connect from each previous node
    for (const prevId of prevIds) {
      edges.push({ id: randomUUID(), source: prevId, target: id });
    }
    prevIds = [id];
    y += 120;
  }

  return {
    schemaVersion: 1,
    name: record.name,
    description: record.description ?? undefined,
    nodes,
    edges,
  };
}

function skillToFlow(record: SkillRecord, revision: SkillRevision): FlowDefinition {
  const def = revision.definition;
  const triggerId = randomUUID();
  const aiId = randomUUID();
  const ttsId = randomUUID();

  const nodes: FlowNode[] = [
    {
      id: triggerId,
      type: 'trigger_voice',
      position: { x: 200, y: 50 },
      label: '',
      config: {
        phrases: (def.invocation?.phrases ?? []).join('\n'),
        keywords: (def.invocation?.keywords ?? []).join('\n'),
      },
    },
    {
      id: aiId,
      type: 'action_ai_reply',
      position: { x: 200, y: 200 },
      label: 'AI response',
      config: {
        prompt: `You are acting as the skill: ${def.name}.\n${def.instructions ?? ''}\n\nUser said: {{transcript}}`,
        result_variable: 'reply',
      },
    },
    {
      id: ttsId,
      type: 'action_tts',
      position: { x: 200, y: 340 },
      label: 'Speak reply',
      config: { text: '{{reply}}' },
    },
  ];

  const edges: FlowEdge[] = [
    { id: randomUUID(), source: triggerId, target: aiId },
    { id: randomUUID(), source: aiId, target: ttsId },
  ];

  return {
    schemaVersion: 1,
    name: record.name,
    description: record.description ?? undefined,
    nodes,
    edges,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export default function LegacyAutomationsSection() {
  const navigate = useNavigate();
  const [routines, setRoutines] = useState<RoutineRecord[]>([]);
  const [skills, setSkills] = useState<SkillRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [migrating, setMigrating] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const [r, s] = await Promise.all([
        coreApi.routines().catch(() => ({ routines: [] as RoutineRecord[] })),
        coreApi.skills().catch(() => ({ skills: [] as SkillRecord[] })),
      ]);
      setRoutines(r.routines);
      setSkills(s.skills);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const migrateRoutine = async (record: RoutineRecord) => {
    setMigrating(record.id);
    try {
      // Load the full routine with revisions to get definition
      const detail = await coreApi.routine(record.id);
      const rev = detail.routine.revisions?.[0];
      if (!rev) throw new Error('No revision found');
      const flowDef = routineToFlow(detail.routine, rev);
      const flow = await coreApi.createFlow(flowDef);
      setMessage(`Migrated "${record.name}" to flow. Opening editor…`);
      setTimeout(() => navigate(`/flows/${flow.id}`), 800);
    } catch (e) {
      setError(`Migration failed: ${String(e)}`);
    } finally {
      setMigrating(null);
    }
  };

  const migrateSkill = async (record: SkillRecord) => {
    setMigrating(record.id);
    try {
      const detail = await coreApi.skill(record.id);
      const rev = detail.skill.revisions?.[0];
      if (!rev) throw new Error('No revision found');
      const flowDef = skillToFlow(detail.skill, rev);
      const flow = await coreApi.createFlow(flowDef);
      setMessage(`Migrated "${record.name}" to flow. Opening editor…`);
      setTimeout(() => navigate(`/flows/${flow.id}`), 800);
    } catch (e) {
      setError(`Migration failed: ${String(e)}`);
    } finally {
      setMigrating(null);
    }
  };

  const total = routines.length + skills.length;

  return (
    <Box>
      {/* Deprecation banner */}
      <Alert
        severity="warning"
        icon={<AccountTreeIcon />}
        action={
          <Button size="small" onClick={() => navigate('/flows')} endIcon={<OpenInNewIcon />}>
            Open Automations
          </Button>
        }
        sx={{ mb: 3 }}
      >
        <Typography sx={{ fontWeight: 600 }}>Routines and Skills are deprecated</Typography>
        <Typography variant="body2">
          The new visual <strong>Automations</strong> (Flows) system replaces routines and skills.
          Migrate your existing automations below — each converts to an editable flow in the visual editor.
          Existing routines and skills continue to work until you're ready to remove them.
        </Typography>
      </Alert>

      {message && <Alert severity="success" onClose={() => setMessage('')} sx={{ mb: 2 }}>{message}</Alert>}
      {error && <Alert severity="error" onClose={() => setError('')} sx={{ mb: 2 }}>{error}</Alert>}

      {loading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', mt: 4 }}><CircularProgress /></Box>
      ) : total === 0 ? (
        <Paper sx={{ p: 4, textAlign: 'center' }}>
          <CallMergeIcon sx={{ fontSize: 48, color: 'text.disabled', mb: 1 }} />
          <Typography color="text.secondary">No routines or skills to migrate.</Typography>
          <Typography variant="body2" sx={{ color: 'text.disabled', mt: 0.5 }}>
            Use the <strong>Automations</strong> section to build new flows.
          </Typography>
          <Button variant="outlined" sx={{ mt: 2 }} onClick={() => navigate('/flows')}>
            Go to Automations
          </Button>
        </Paper>
      ) : (
        <Stack spacing={3}>
          {/* Routines */}
          {routines.length > 0 && (
            <Box>
              <Stack direction="row" sx={{ alignItems: 'center', gap: 1, mb: 1.5 }}>
                <Typography variant="h6">Routines</Typography>
                <Chip label={routines.length} size="small" />
                <Chip label="deprecated" size="small" color="warning" variant="outlined" />
              </Stack>
              <Stack spacing={1}>
                {routines.map(r => (
                  <Paper key={r.id} variant="outlined" sx={{ p: 2 }}>
                    <Stack direction="row" sx={{ alignItems: 'center', gap: 2 }}>
                      <Box sx={{ flex: 1 }}>
                        <Stack direction="row" sx={{ alignItems: 'center', gap: 1 }}>
                          <Typography sx={{ fontWeight: 600 }}>{r.name}</Typography>
                          <Chip
                            label={r.status}
                            size="small"
                            color={r.status === 'enabled' ? 'success' : 'default'}
                          />
                        </Stack>
                        {r.description && (
                          <Typography variant="body2" sx={{ color: 'text.secondary', mt: 0.25 }}>
                            {r.description}
                          </Typography>
                        )}
                        <Typography variant="caption" sx={{ color: 'text.disabled' }}>
                          Owner: {r.owner} · Last updated: {new Date(r.updated_at).toLocaleDateString()}
                        </Typography>
                      </Box>
                      <Tooltip title="Convert this routine to a visual flow in the new Automations system">
                        <span>
                          <Button
                            variant="outlined"
                            size="small"
                            startIcon={migrating === r.id ? <CircularProgress size={14} /> : <CallMergeIcon />}
                            disabled={!!migrating}
                            onClick={() => migrateRoutine(r)}
                            color="primary"
                          >
                            Migrate to Flow
                          </Button>
                        </span>
                      </Tooltip>
                    </Stack>
                  </Paper>
                ))}
              </Stack>
            </Box>
          )}

          <Divider />

          {/* Skills */}
          {skills.length > 0 && (
            <Box>
              <Stack direction="row" sx={{ alignItems: 'center', gap: 1, mb: 1.5 }}>
                <Typography variant="h6">Skills</Typography>
                <Chip label={skills.length} size="small" />
                <Chip label="deprecated" size="small" color="warning" variant="outlined" />
              </Stack>
              <Stack spacing={1}>
                {skills.map(s => (
                  <Paper key={s.id} variant="outlined" sx={{ p: 2 }}>
                    <Stack direction="row" sx={{ alignItems: 'center', gap: 2 }}>
                      <Box sx={{ flex: 1 }}>
                        <Stack direction="row" sx={{ alignItems: 'center', gap: 1 }}>
                          <Typography sx={{ fontWeight: 600 }}>{s.name}</Typography>
                          <Chip
                            label={s.status}
                            size="small"
                            color={s.status === 'enabled' ? 'success' : 'default'}
                          />
                        </Stack>
                        {s.description && (
                          <Typography variant="body2" sx={{ color: 'text.secondary', mt: 0.25 }}>
                            {s.description}
                          </Typography>
                        )}
                      </Box>
                      <Tooltip title="Convert this skill to a visual flow in the new Automations system">
                        <span>
                          <Button
                            variant="outlined"
                            size="small"
                            startIcon={migrating === s.id ? <CircularProgress size={14} /> : <CallMergeIcon />}
                            disabled={!!migrating}
                            onClick={() => migrateSkill(s)}
                            color="primary"
                          >
                            Migrate to Flow
                          </Button>
                        </span>
                      </Tooltip>
                    </Stack>
                  </Paper>
                ))}
              </Stack>
            </Box>
          )}

          {/* Advanced: old UIs behind an accordion */}
          <Accordion sx={{ mt: 1 }}>
            <AccordionSummary expandIcon={<ExpandMoreIcon />}>
              <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                Advanced: edit routines/skills directly (legacy)
              </Typography>
            </AccordionSummary>
            <AccordionDetails>
              <Alert severity="info" sx={{ mb: 2 }}>
                These editors are kept for advanced users who need low-level access.
                Prefer the visual Automations editor for new work.
              </Alert>
              <Button
                variant="text"
                size="small"
                onClick={() => navigate('/flows')}
                startIcon={<AccountTreeIcon />}
              >
                Go to Automations instead
              </Button>
            </AccordionDetails>
          </Accordion>
        </Stack>
      )}
    </Box>
  );
}
