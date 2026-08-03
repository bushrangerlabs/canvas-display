import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import type { LlmProvider } from "./providers/llm.js";
import type { ChatMessage } from "./providers/types.js";
import type { RoutineEngine } from "./routines.js";
import type { ToolContext, ToolRegistry } from "./tool-registry.js";

export const skillDefinitionSchema = z
  .object({
    schemaVersion: z.literal(1),
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(1000).default(""),
    instructions: z.string().trim().min(1).max(12_000),
    invocation: z
      .object({
        phrases: z.array(z.string().trim().min(1).max(200)).max(30).default([]),
        keywords: z.array(z.string().trim().min(2).max(80)).max(30).default([]),
        examples: z
          .array(z.string().trim().min(1).max(300))
          .max(30)
          .default([]),
      })
      .strict(),
    allowedTools: z
      .array(z.string().trim().min(1).max(200))
      .max(50)
      .default([]),
    routineId: z.string().uuid().nullable().default(null),
    responseStyle: z.string().trim().max(1000).default(""),
  })
  .strict();
export type SkillDefinition = z.infer<typeof skillDefinitionSchema>;

function validate(raw: unknown, tools?: ToolRegistry) {
  const parsed = skillDefinitionSchema.safeParse(raw);
  if (!parsed.success)
    return {
      valid: false as const,
      errors: parsed.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    };
  const errors = tools
    ? parsed.data.allowedTools
        .filter((name) => !tools.getTool(name))
        .map((name) => ({
          path: "allowedTools",
          message: `Unknown tool: ${name}`,
        }))
    : [];
  return errors.length
    ? { valid: false as const, errors }
    : { valid: true as const, definition: parsed.data, errors: [] };
}

async function tx<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const value = await fn(client);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
class SkillError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export class SkillService {
  constructor(
    private readonly pool: Pool,
    private readonly tools: ToolRegistry,
    private readonly llm: LlmProvider,
    private readonly routine: () => RoutineEngine | null,
    private readonly getToolContext: () => Partial<ToolContext> = () => ({}),
  ) {}
  registerTools() {
    if (!this.tools.getTool("skill.plan"))
      this.tools.register({
        name: "skill.plan",
        description:
          "Plan a validated Canvas Skill v1 draft from a prompt without saving or enabling it.",
        schema: {
          type: "object",
          properties: { prompt: { type: "string" } },
          required: ["prompt"],
        },
        requiredRole: "admin",
        requiresConfirmation: false,
        executor: async (params) => {
          try {
            return {
              ok: true,
              message: "Skill plan created for review.",
              data: await this.plan(String(params.prompt ?? "")),
            };
          } catch (error) {
            return {
              ok: false,
              message: error instanceof Error ? error.message : String(error),
            };
          }
        },
      });
    if (!this.tools.getTool("skill.create_draft"))
      this.tools.register({
        name: "skill.create_draft",
        description:
          "Save a complete schema-valid Canvas Skill v1 as a disabled draft. This never enables it.",
        schema: {
          type: "object",
          properties: { definition: { type: "object" } },
          required: ["definition"],
        },
        requiredRole: "admin",
        requiresConfirmation: true,
        executor: async (params) => {
          try {
            return {
              ok: true,
              message: "Skill draft created and left disabled.",
              data: await this.create(params.definition, "ai_prompt"),
            };
          } catch (error) {
            return {
              ok: false,
              message: error instanceof Error ? error.message : String(error),
            };
          }
        },
      });
  }
  async list() {
    return (
      await this.pool.query(
        `SELECT s.*,r.revision AS active_revision FROM skills s LEFT JOIN skill_revisions r ON r.id=s.active_revision_id ORDER BY s.name`,
      )
    ).rows;
  }
  async get(id: string) {
    const skill = (
      await this.pool.query("SELECT * FROM skills WHERE id=$1", [id])
    ).rows[0];
    if (!skill) return null;
    const revisions = (
      await this.pool.query(
        "SELECT * FROM skill_revisions WHERE skill_id=$1 ORDER BY revision DESC",
        [id],
      )
    ).rows;
    return { ...skill, revisions };
  }
  async create(raw: unknown, source = "user") {
    const checked = validate(raw, this.tools);
    if (!checked.valid)
      throw new SkillError("skill_invalid", 400, checked.errors);
    return tx(this.pool, async (client) => {
      const id = randomUUID(),
        revisionId = randomUUID();
      await client.query(
        `INSERT INTO skills(id,name,description,status) VALUES($1,$2,$3,'draft')`,
        [id, checked.definition.name, checked.definition.description],
      );
      const revision = (
        await client.query(
          `INSERT INTO skill_revisions(id,skill_id,revision,definition,status,creation_source) VALUES($1,$2,1,$3::jsonb,'draft',$4) RETURNING *`,
          [revisionId, id, JSON.stringify(checked.definition), source],
        )
      ).rows[0];
      return { id, status: "draft", revision };
    });
  }
  async revise(id: string, raw: unknown, source = "user") {
    const checked = validate(raw, this.tools);
    if (!checked.valid)
      throw new SkillError("skill_invalid", 400, checked.errors);
    return tx(this.pool, async (client) => {
      const skill = (
        await client.query("SELECT * FROM skills WHERE id=$1 FOR UPDATE", [id])
      ).rows[0];
      if (!skill) throw new SkillError("skill_not_found", 404);
      if (skill.status === "archived")
        throw new SkillError("skill_archived", 409);
      const revision = Number(
        (
          await client.query(
            "SELECT COALESCE(MAX(revision),0)+1 value FROM skill_revisions WHERE skill_id=$1",
            [id],
          )
        ).rows[0].value,
      );
      const row = (
        await client.query(
          `INSERT INTO skill_revisions(id,skill_id,revision,definition,status,creation_source) VALUES($1,$2,$3,$4::jsonb,'draft',$5) RETURNING *`,
          [
            randomUUID(),
            id,
            revision,
            JSON.stringify(checked.definition),
            source,
          ],
        )
      ).rows[0];
      await client.query(
        "UPDATE skills SET name=$2,description=$3,updated_at=now() WHERE id=$1",
        [id, checked.definition.name, checked.definition.description],
      );
      return row;
    });
  }
  async enable(id: string, revision?: number) {
    return tx(this.pool, async (client) => {
      const row = (
        await client.query(
          revision === undefined
            ? "SELECT * FROM skill_revisions WHERE skill_id=$1 ORDER BY revision DESC LIMIT 1"
            : "SELECT * FROM skill_revisions WHERE skill_id=$1 AND revision=$2",
          [id, ...(revision === undefined ? [] : [revision])],
        )
      ).rows[0];
      if (!row) throw new SkillError("skill_revision_not_found", 404);
      const checked = validate(row.definition, this.tools);
      if (!checked.valid)
        throw new SkillError("skill_invalid", 409, checked.errors);
      if (checked.definition.routineId) {
        const backing = await this.routinePermissions(
          checked.definition.routineId,
        );
        if (!backing) throw new SkillError("skill_routine_not_enabled", 409);
        const undeclared = backing.filter(
          (tool) => !checked.definition.allowedTools.includes(tool),
        );
        if (undeclared.length)
          throw new SkillError(
            "skill_routine_permissions_not_declared",
            409,
            undeclared,
          );
      }
      await client.query(
        "UPDATE skill_revisions SET status='superseded' WHERE skill_id=$1 AND status='enabled'",
        [id],
      );
      await client.query(
        "UPDATE skill_revisions SET status='enabled',enabled_at=now() WHERE id=$1",
        [row.id],
      );
      const skill = (
        await client.query(
          "UPDATE skills SET status='enabled',active_revision_id=$2,updated_at=now() WHERE id=$1 AND status<>'archived' RETURNING *",
          [id, row.id],
        )
      ).rows[0];
      if (!skill) throw new SkillError("skill_not_found_or_archived", 409);
      return { ...skill, active_revision: row.revision };
    });
  }
  async status(id: string, status: "disabled" | "archived") {
    const row = (
      await this.pool.query(
        "UPDATE skills SET status=$2,updated_at=now() WHERE id=$1 RETURNING *",
        [id, status],
      )
    ).rows[0];
    if (!row) throw new SkillError("skill_not_found", 404);
    return row;
  }
  async plan(prompt: string) {
    if (!prompt.trim()) throw new SkillError("skill_prompt_required");
    const routines = (
      await this.pool.query(
        "SELECT id,name,description FROM routines WHERE status<>'archived' ORDER BY name LIMIT 100",
      )
    ).rows;
    const availableTools = this.tools
      .listTools("admin")
      .map((t) => ({ name: t.name, description: t.description }));
    const raw = await this.llm.chat([
      {
        role: "system",
        content:
          "Create one Canvas Skill v1 disabled draft. Return JSON only. Shape: {schemaVersion:1,name,description,instructions,invocation:{phrases,keywords,examples},allowedTools,routineId,responseStyle}. Use only supplied exact tool and routine IDs. A skill is reusable guidance and optional routine backing, never executable code. Keep allowedTools least-privilege.",
      },
      {
        role: "user",
        content: JSON.stringify({ request: prompt, availableTools, routines }),
      },
    ]);
    const start = raw.indexOf("{"),
      end = raw.lastIndexOf("}");
    if (start < 0 || end < start)
      throw new SkillError("skill_planner_returned_no_json", 502);
    const definition = JSON.parse(raw.slice(start, end + 1));
    const checked = validate(definition, this.tools);
    return {
      prompt,
      definition: checked.valid ? checked.definition : null,
      validation: checked,
      risk:
        checked.valid &&
        checked.definition.allowedTools.some((t) =>
          this.tools.requiresConfirmation(t),
        )
          ? "elevated"
          : "normal",
      remainsDisabled: true,
    };
  }
  async invokeVoice(transcript: string, deviceId?: string) {
    const rows = (
      await this.pool.query(
        `SELECT s.id,s.name,r.definition FROM skills s JOIN skill_revisions r ON r.id=s.active_revision_id WHERE s.status='enabled'`,
      )
    ).rows;
    const normalized = norm(transcript);
    const matches = rows.filter((row) => {
      const d = skillDefinitionSchema.safeParse(row.definition);
      return (
        d.success &&
        (d.data.invocation.phrases.some((p) => norm(p) === normalized) ||
          d.data.invocation.keywords.filter((k) => normalized.includes(norm(k)))
            .length >= Math.min(2, d.data.invocation.keywords.length || 99))
      );
    });
    if (!matches.length) return { matched: false };
    if (matches.length > 1)
      return { matched: false, ambiguous: matches.map((r) => String(r.name)) };
    const definition = skillDefinitionSchema.parse(matches[0].definition);
    console.log(
      `[core][skills] matched enabled skill=${matches[0].id} name=${JSON.stringify(definition.name)}`,
    );
    if (definition.routineId) {
      const engine = this.routine();
      if (!engine)
        return {
          matched: true,
          reply: "The skill is available, but its routine engine is not ready.",
        };
      const result = await engine.run(definition.routineId, {
        origin: "skill",
        originDeviceId: deviceId,
        principal: "voice_user",
        role: "voice",
      });
      return { matched: true, reply: `${definition.name} completed.`, result };
    }
    const messages: ChatMessage[] = [
      {
        role: "system",
        content: `You are executing the enabled Canvas skill “${definition.name}”. Follow these instructions:\n${definition.instructions}\nResponse style: ${definition.responseStyle || "concise spoken response"}. Use an allowed tool whenever current external data is required. Never invent tool results.`,
      },
      { role: "user", content: transcript },
    ];
    const allowed = definition.allowedTools
      .map((name) => this.tools.getTool(name))
      .filter((tool) => tool !== undefined);
    if (!allowed.length)
      return { matched: true, reply: await this.llm.chat(messages) };
    const toolDefinitions = allowed.map((tool) => ({
      type: "function" as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.schema,
      },
    }));
    let finalReply = "";
    for (let iteration = 0; iteration < 3; iteration++) {
      const answer = await this.llm.chatWithTools(messages, toolDefinitions);
      if (answer.content) finalReply = answer.content;
      if (!answer.toolCalls.length) return { matched: true, reply: finalReply };
      messages.push({
        role: "assistant",
        content: answer.content,
        tool_calls: answer.toolCalls,
      });
      for (const call of answer.toolCalls) {
        const tool = allowed.find(
          (candidate) => candidate.name === call.function.name,
        );
        if (!tool)
          return {
            matched: true,
            reply:
              "That skill requested a tool outside its allowed permissions.",
          };
        if (tool.requiresConfirmation)
          return {
            matched: true,
            reply: `The ${definition.name} skill needs confirmation before it can use ${tool.name}.`,
          };
        let args: Record<string, unknown>;
        try {
          args = JSON.parse(call.function.arguments || "{}");
        } catch {
          return {
            matched: true,
            reply: `The ${definition.name} skill produced invalid tool arguments.`,
          };
        }
        const result = await this.tools.executeTool(tool.name, args, {
          ...this.getToolContext(),
          principal: "voice_user",
          role: "voice",
          deviceId,
        });
        console.log(
          `[core][skills] skill=${matches[0].id} executed tool=${tool.name} ok=${result.ok}`,
        );
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify(result),
        });
      }
    }
    return {
      matched: true,
      reply:
        finalReply ||
        "The skill could not complete within its tool-call limit.",
    };
  }
  private async routinePermissions(id: string): Promise<string[] | null> {
    const row = (
      await this.pool.query(
        `SELECT rr.definition FROM routines r JOIN routine_revisions rr ON rr.id=r.active_revision_id WHERE r.id=$1 AND r.status='enabled'`,
        [id],
      )
    ).rows[0];
    if (!row) return null;
    const steps = Array.isArray(row.definition?.steps)
      ? row.definition.steps
      : [];
    return steps
      .filter((s: Record<string, unknown>) => s.kind === "tool")
      .map((s: Record<string, any>) => String(s.config?.tool))
      .filter(Boolean);
  }
}
function norm(v: string) {
  return v
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
type RequireAdmin = (opts?: {
  roles?: ("admin" | "viewer")[];
  csrf?: boolean;
}) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
export function registerSkillRoutes(
  fastify: FastifyInstance,
  service: SkillService,
  requireAdmin: RequireAdmin,
) {
  const handle = (reply: FastifyReply, error: unknown) =>
    error instanceof SkillError
      ? reply
          .code(error.statusCode)
          .send({ error: error.message, details: error.details })
      : Promise.reject(error);
  fastify.get(
    "/api/admin/skills",
    { preHandler: requireAdmin({ roles: ["admin", "viewer"], csrf: false }) },
    async () => ({ skills: await service.list() }),
  );
  fastify.get(
    "/api/admin/skills/:id",
    { preHandler: requireAdmin({ roles: ["admin", "viewer"], csrf: false }) },
    async (request, reply) => {
      const value = await service.get((request.params as { id: string }).id);
      return value
        ? { skill: value }
        : reply.code(404).send({ error: "skill_not_found" });
    },
  );
  fastify.post(
    "/api/admin/skills/plan",
    { preHandler: requireAdmin({ roles: ["admin"], csrf: true }) },
    async (request, reply) => {
      try {
        return {
          ok: true,
          plan: await service.plan(
            String((request.body as { prompt?: unknown })?.prompt ?? ""),
          ),
        };
      } catch (e) {
        return handle(reply, e);
      }
    },
  );
  fastify.post(
    "/api/admin/skills",
    { preHandler: requireAdmin({ roles: ["admin"], csrf: true }) },
    async (request, reply) => {
      try {
        return {
          ok: true,
          skill: await service.create(
            (request.body as { definition?: unknown })?.definition,
            (request.body as { source?: string })?.source,
          ),
        };
      } catch (e) {
        return handle(reply, e);
      }
    },
  );
  fastify.post(
    "/api/admin/skills/:id/revisions",
    { preHandler: requireAdmin({ roles: ["admin"], csrf: true }) },
    async (request, reply) => {
      try {
        return {
          ok: true,
          revision: await service.revise(
            (request.params as { id: string }).id,
            (request.body as { definition?: unknown })?.definition,
          ),
        };
      } catch (e) {
        return handle(reply, e);
      }
    },
  );
  fastify.post(
    "/api/admin/skills/:id/enable",
    { preHandler: requireAdmin({ roles: ["admin"], csrf: true }) },
    async (request, reply) => {
      try {
        return {
          ok: true,
          skill: await service.enable(
            (request.params as { id: string }).id,
            (request.body as { revision?: number })?.revision,
          ),
        };
      } catch (e) {
        return handle(reply, e);
      }
    },
  );
  for (const status of ["disabled", "archived"] as const)
    fastify.post(
      `/api/admin/skills/:id/${status === "disabled" ? "disable" : "archive"}`,
      { preHandler: requireAdmin({ roles: ["admin"], csrf: true }) },
      async (request, reply) => {
        try {
          return {
            ok: true,
            skill: await service.status(
              (request.params as { id: string }).id,
              status,
            ),
          };
        } catch (e) {
          return handle(reply, e);
        }
      },
    );
}
