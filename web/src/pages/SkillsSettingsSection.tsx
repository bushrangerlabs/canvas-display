import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  Button,
  Chip,
  Divider,
  MenuItem,
  Paper,
  Select,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import {
  coreApi,
  type RoutineRecord,
  type SkillDefinition,
  type SkillPlan,
  type SkillRecord,
} from "../api/client";

type SkillSuggestion = { intent: string; count: number; last_seen: string; avg_feedback: number | null };
const blank = (): SkillDefinition => ({
  schemaVersion: 1,
  name: "New skill",
  description: "",
  instructions: "Describe exactly how Canvas should handle this request.",
  invocation: { phrases: [], keywords: [], examples: [] },
  allowedTools: [],
  routineId: null,
  responseStyle: "Concise spoken response",
});
const csv = (v: string) =>
  v
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
export default function SkillsSettingsSection() {
  const [skills, setSkills] = useState<SkillRecord[]>([]),
    [routines, setRoutines] = useState<RoutineRecord[]>([]);
  const [selected, setSelected] = useState("new"),
    [definition, setDefinition] = useState(blank());
  const [prompt, setPrompt] = useState(""),
    [plan, setPlan] = useState<SkillPlan | null>(null),
    [message, setMessage] = useState<string | null>(null),
    [error, setError] = useState<string | null>(null),
    [busy, setBusy] = useState(false);
  const [suggestions, setSuggestions] = useState<SkillSuggestion[]>([]);
  const load = useCallback(async () => {
    const [s, r] = await Promise.all([coreApi.skills(), coreApi.routines()]);
    setSkills(s.skills);
    setRoutines(r.routines);
    coreApi.skillSuggestions().then(r => setSuggestions(r.suggestions)).catch(() => {/* not fatal */});
  }, []);
  useEffect(() => {
    void load().catch((e) => setError(String(e)));
  }, [load]);
  useEffect(() => {
    if (selected === "new") {
      setDefinition(blank());
      return;
    }
    void coreApi
      .skill(selected)
      .then((r) => {
        const rev = r.skill.revisions?.[0];
        if (rev) setDefinition(structuredClone(rev.definition));
      })
      .catch((e) => setError(String(e)));
  }, [selected]);
  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const save = () =>
    act(async () => {
      if (selected === "new") {
        const r = await coreApi.createSkill(definition);
        setSelected(r.skill.id);
        setMessage("Disabled skill draft created.");
      } else {
        await coreApi.reviseSkill(selected, definition);
        setMessage("Immutable draft revision saved.");
      }
    });
  return (
    <Stack spacing={2}>
      {error && <Alert severity="error">{error}</Alert>}
      {message && <Alert severity="success">{message}</Alert>}
      {suggestions.length > 0 && (
        <Paper sx={{ p: 2 }}>
          <Typography variant="h6">Suggested Skills</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
            Intents seen ≥2 times with no matching skill. Click "Create" to pre-fill the skill editor.
          </Typography>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Intent</TableCell>
                <TableCell align="right">Requests</TableCell>
                <TableCell>Last seen</TableCell>
                <TableCell align="right">Avg feedback</TableCell>
                <TableCell />
              </TableRow>
            </TableHead>
            <TableBody>
              {suggestions.map((s) => (
                <TableRow key={s.intent}>
                  <TableCell><code>{s.intent}</code></TableCell>
                  <TableCell align="right">{s.count}</TableCell>
                  <TableCell>{new Date(s.last_seen).toLocaleDateString()}</TableCell>
                  <TableCell align="right">
                    {s.avg_feedback != null ? (s.avg_feedback > 0 ? '👍' : s.avg_feedback < 0 ? '👎' : '—') : '—'}
                  </TableCell>
                  <TableCell>
                    <Tooltip title="Pre-fill skill editor with AI plan for this intent">
                      <Button
                        size="small"
                        variant="outlined"
                        disabled={busy}
                        onClick={() =>
                          void act(async () => {
                            const r = await coreApi.planSkill(`Handle "${s.intent}" intent: ${s.intent.replace(/_/g, ' ')}`);
                            setPlan(r.plan);
                            if (r.plan.definition) {
                              setDefinition(structuredClone(r.plan.definition));
                              setSelected("new");
                            }
                            setMessage(`Skill planned for intent "${s.intent}"; review in editor below.`);
                          })
                        }
                      >
                        Create
                      </Button>
                    </Tooltip>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Paper>
      )}
      <Paper sx={{ p: 2 }}>
        <Typography variant="h6">Create a skill with AI</Typography>
        <Typography variant="body2" color="text.secondary">
          Generated skills remain disabled until reviewed and enabled.
        </Typography>
        <Stack
          direction={{ xs: "column", md: "row" }}
          spacing={1}
          sx={{ mt: 1 }}
        >
          <TextField
            fullWidth
            size="small"
            label="What should this skill know or do?"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
          />
          <Button
            disabled={busy || !prompt.trim()}
            variant="contained"
            onClick={() =>
              void act(async () => {
                const r = await coreApi.planSkill(prompt);
                setPlan(r.plan);
                setMessage("Skill planned; nothing was enabled.");
              })
            }
          >
            Plan
          </Button>
        </Stack>
        {plan?.definition && (
          <Paper variant="outlined" sx={{ p: 1.5, mt: 1 }}>
            <Chip label={`Risk: ${plan.risk}`} />
              <Typography sx={{ mt: 1, fontWeight: 600 }}>
              {plan.definition.name}
            </Typography>
            <Typography variant="body2">
              {plan.definition.description}
            </Typography>
            <Button
              sx={{ mt: 1 }}
              onClick={() => {
                setDefinition(structuredClone(plan.definition!));
                setSelected("new");
              }}
            >
              Review in editor
            </Button>
          </Paper>
        )}
      </Paper>
      <Stack direction={{ xs: "column", md: "row" }} spacing={2}>
        <Paper sx={{ p: 2, width: { md: 260 } }}>
          <Button
            fullWidth
            variant="contained"
            onClick={() => setSelected("new")}
          >
            New skill
          </Button>
          {skills.map((s) => (
            <Button
              fullWidth
              key={s.id}
              onClick={() => setSelected(s.id)}
              variant={selected === s.id ? "outlined" : "text"}
              sx={{ justifyContent: "space-between", mt: 0.5 }}
            >
              {s.name}
              <Chip size="small" label={s.status} />
            </Button>
          ))}
        </Paper>
        <Paper sx={{ p: 2, flex: 1 }}>
          <Typography variant="h6">Skill editor</Typography>
          <Divider sx={{ my: 1.5 }} />
          <Stack spacing={1.5}>
            <TextField
              size="small"
              label="Name"
              value={definition.name}
              onChange={(e) =>
                setDefinition({ ...definition, name: e.target.value })
              }
            />
            <TextField
              size="small"
              label="Description"
              value={definition.description}
              onChange={(e) =>
                setDefinition({ ...definition, description: e.target.value })
              }
            />
            <TextField
              multiline
              minRows={5}
              label="Instructions"
              value={definition.instructions}
              onChange={(e) =>
                setDefinition({ ...definition, instructions: e.target.value })
              }
            />
            <TextField
              size="small"
              label="Exact phrases (comma separated)"
              value={definition.invocation.phrases.join(", ")}
              onChange={(e) =>
                setDefinition({
                  ...definition,
                  invocation: {
                    ...definition.invocation,
                    phrases: csv(e.target.value),
                  },
                })
              }
            />
            <TextField
              size="small"
              label="Keywords (comma separated; two match)"
              value={definition.invocation.keywords.join(", ")}
              onChange={(e) =>
                setDefinition({
                  ...definition,
                  invocation: {
                    ...definition.invocation,
                    keywords: csv(e.target.value),
                  },
                })
              }
            />
            <TextField
              size="small"
              label="Example requests"
              value={definition.invocation.examples.join(", ")}
              onChange={(e) =>
                setDefinition({
                  ...definition,
                  invocation: {
                    ...definition.invocation,
                    examples: csv(e.target.value),
                  },
                })
              }
            />
            <TextField
              size="small"
              label="Allowed typed tools"
              value={definition.allowedTools.join(", ")}
              onChange={(e) =>
                setDefinition({
                  ...definition,
                  allowedTools: csv(e.target.value),
                })
              }
            />
            <Select
              size="small"
              value={definition.routineId ?? ""}
              displayEmpty
              onChange={(e) =>
                setDefinition({
                  ...definition,
                  routineId: e.target.value || null,
                })
              }
            >
              <MenuItem value="">Prompt-only skill</MenuItem>
              {routines.map((r) => (
                <MenuItem key={r.id} value={r.id}>
                  {r.name} · {r.status}
                </MenuItem>
              ))}
            </Select>
            <TextField
              size="small"
              label="Response style"
              value={definition.responseStyle}
              onChange={(e) =>
                setDefinition({ ...definition, responseStyle: e.target.value })
              }
            />
            <Stack direction="row" spacing={1}>
              <Button disabled={busy} variant="contained" onClick={save}>
                Save draft
              </Button>
              <Button
                disabled={busy || selected === "new"}
                variant="outlined"
                onClick={() =>
                  void act(async () => {
                    await coreApi.enableSkill(selected);
                    setMessage("Latest skill enabled.");
                  })
                }
              >
                Enable latest
              </Button>
              {skills.find((s) => s.id === selected)?.status === "enabled" && (
                <Button
                  color="warning"
                  onClick={() =>
                    void act(async () => {
                      await coreApi.setSkillStatus(selected, "disable");
                      setMessage("Skill disabled.");
                    })
                  }
                >
                  Disable
                </Button>
              )}
            </Stack>
          </Stack>
        </Paper>
      </Stack>
    </Stack>
  );
}
