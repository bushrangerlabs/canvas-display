import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import fastifyCookie from '@fastify/cookie';
import { randomBytes, randomUUID, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { CoreConfig } from './config.js';
import type { Pool } from 'pg';

const scrypt = promisify(scryptCb);

/**
 * Admin auth scaffold (Phase 2 checklist: "authenticated admin users, roles,
 * sessions, authorization, and CSRF protection"; plan doc §13.5; aligns with
 * `docs/PHASE_0_ADMIN_SECURITY_SPEC.md`).
 *
 * PRAGMATIC FIRST CUT — not the full production model:
 *   - Passwords hashed with Node's built-in `scrypt` (the spec's executable model
 *     uses scrypt to prove plaintext is never retained). Production should move to a
 *     reviewed Argon2id profile (see spec "Production gates still open").
 *   - Sessions are stateless JWTs in an `HttpOnly` cookie (the spec recommends
 *     hash-only server-side session storage; that lands with the real session table).
 *   - CSRF uses the double-submit-cookie pattern bound to the session JWT: a
 *     non-`HttpOnly` `csrf_token` cookie plus an `X-CSRF-Token` header that must equal
 *     both the cookie and the `csrf` claim embedded in the JWT.
 *   - Authorization is deny-by-default after authentication; roles are extensible.
 *
 * The repository is injected so unit tests can run against an in-memory Postgres
 * (`pg-mem`) without a network.
 */

export type AdminRole = 'admin' | 'viewer' | 'voice';

export interface AdminUser {
  id: string;
  username: string;
  role: AdminRole;
}

export interface SessionClaims {
  sub: string; // admin user id
  username: string;
  role: AdminRole;
  csrf: string;
  iat?: number;
  exp?: number;
}

/** Storage abstraction so tests can swap in an in-memory Postgres. */
export interface AuthRepository {
  countAdmins(): Promise<number>;
  findAdminByUsername(username: string): Promise<{ id: string; username: string; passwordHash: string; role: AdminRole } | null>;
  findAdminById(id: string): Promise<{ id: string; username: string; role: AdminRole } | null>;
  createAdmin(username: string, passwordHash: string, role: AdminRole): Promise<{ id: string; username: string; role: AdminRole }>;
}

export class PgAuthRepository implements AuthRepository {
  constructor(private readonly pool: Pool) {}

  async countAdmins(): Promise<number> {
    const res = await this.pool.query('SELECT COUNT(*)::int AS n FROM admin_users');
    return Number(res.rows[0]?.n ?? 0);
  }

  async findAdminByUsername(username: string) {
    const res = await this.pool.query(
      'SELECT id, username, password_hash, role FROM admin_users WHERE username = $1 LIMIT 1',
      [username],
    );
    const row = res.rows[0];
    if (!row) return null;
    return { id: row.id, username: row.username, passwordHash: row.password_hash, role: row.role as AdminRole };
  }

  async findAdminById(id: string) {
    const res = await this.pool.query(
      'SELECT id, username, role FROM admin_users WHERE id = $1 LIMIT 1',
      [id],
    );
    const row = res.rows[0];
    if (!row) return null;
    return { id: row.id, username: row.username, role: row.role as AdminRole };
  }

  async createAdmin(username: string, passwordHash: string, role: AdminRole) {
    const id = randomUUID();
    await this.pool.query(
      'INSERT INTO admin_users (id, username, password_hash, role) VALUES ($1, $2, $3, $4)',
      [id, username, passwordHash, role],
    );
    return { id, username, role };
  }
}

// --- password hashing (scrypt; production target is Argon2id) ----------------

function hashPassword(plain: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(plain, salt, 64);
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
}

// scryptSync wrapper to keep the async promisify usage simple and synchronous at call sites.
import { scryptSync } from 'node:crypto';

async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1], 'hex');
  const expected = Buffer.from(parts[2], 'hex');
  const derived = scryptSync(plain, salt, expected.length);
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}

// --- JWT / cookie plumbing ---------------------------------------------------

const SESSION_COOKIE = 'canvas_core_session';
const CSRF_COOKIE = 'csrf_token';
const CSRF_HEADER = 'x-csrf-token';

export interface RequireAdminOptions {
  /** Allowed roles for this route. Defaults to ['admin'] (deny-by-default). */
  roles?: AdminRole[];
  /** Require a matching CSRF token (state-changing routes). Defaults to true for mutations. */
  csrf?: boolean;
}

/**
 * Builds the `requireAdmin` preHandler bound to this server's config. Apply it to
 * every admin route. It verifies the session JWT, enforces role, and (for mutations)
 * enforces the double-submit CSRF token.
 */
export function makeRequireAdmin(config: CoreConfig) {
  return function requireAdmin(opts: RequireAdminOptions = {}) {
    const allowedRoles = opts.roles ?? ['admin'];
    const requireCsrf = opts.csrf ?? true;
    return async function preHandler(request: FastifyRequest, reply: FastifyReply): Promise<void> {
      const authorization = request.headers.authorization;
      const bearer = authorization?.startsWith('Bearer ') ? authorization.slice(7) : '';
      if (config.automationToken && bearer) {
        const supplied = Buffer.from(bearer);
        const expected = Buffer.from(config.automationToken);
        if (supplied.length === expected.length && timingSafeEqual(supplied, expected)) return;
      }
      try {
        await request.jwtVerify();
      } catch {
        await reply.code(401).send({ error: 'unauthenticated' });
        return;
      }
      const claims = request.user as SessionClaims;
      if (!allowedRoles.includes(claims.role)) {
        await reply.code(403).send({ error: 'forbidden', reason: 'insufficient_role' });
        return;
      }
      if (requireCsrf && isStateChanging(request.method)) {
        const headerToken = request.headers[CSRF_HEADER] as string | undefined;
        const cookieToken = request.cookies[CSRF_COOKIE];
        if (!headerToken || !cookieToken || headerToken !== cookieToken || headerToken !== claims.csrf) {
          await reply.code(403).send({ error: 'csrf_mismatch' });
          return;
        }
      }
    };
  };
}

function isStateChanging(method: string): boolean {
  return method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
}

export interface AuthPluginOptions {
  config: CoreConfig;
  repo: AuthRepository;
}

/**
 * Registers `@fastify/jwt` + cookie support and the admin login/logout routes.
 * Returns the `requireAdmin` factory for callers to attach to routes.
 */
export async function registerAuth(
  fastify: FastifyInstance,
  options: AuthPluginOptions,
): Promise<{ requireAdmin: ReturnType<typeof makeRequireAdmin> }> {
  const { config, repo } = options;

  await fastify.register(fastifyCookie);
  await fastify.register(fastifyJwt, {
    secret: config.jwtSecret,
    // Read the session token from our HttpOnly cookie (double-submit CSRF pattern).
    cookie: { cookieName: SESSION_COOKIE, signed: false },
  });

  const requireAdmin = makeRequireAdmin(config);

  // Login: validates credentials, issues a session JWT in an HttpOnly cookie plus a
  // double-submit CSRF cookie.
  fastify.post('/api/admin/login', async (request, reply) => {
    const body = request.body as { username?: unknown; password?: unknown } | undefined;
    if (typeof body?.username !== 'string' || typeof body?.password !== 'string') {
      reply.code(400);
      return { error: 'username and password required' };
    }
    const user = await repo.findAdminByUsername(body.username);
    if (!user || !(await verifyPassword(body.password, user.passwordHash))) {
      reply.code(401);
      return { error: 'invalid_credentials' };
    }
    const csrf = randomBytes(24).toString('hex');
    const token = fastify.jwt.sign(
      { sub: user.id, username: user.username, role: user.role, csrf },
      { expiresIn: '12h' },
    );
    reply
      .setCookie(SESSION_COOKIE, token, {
        httpOnly: true,
        secure: config.cookieSecure,
        sameSite: 'strict',
        path: '/',
      })
      .setCookie(CSRF_COOKIE, csrf, {
        httpOnly: false,
        secure: config.cookieSecure,
        sameSite: 'strict',
        path: '/',
      });
    return { ok: true, username: user.username, role: user.role };
  });

  // Logout: clears both cookies. (Stateless JWT; real revocation lands with the
  // server-side session table per the security spec.)
  fastify.post('/api/admin/logout', async (_request, reply) => {
    reply
      .clearCookie(SESSION_COOKIE, { path: '/' })
      .clearCookie(CSRF_COOKIE, { path: '/' });
    return { ok: true };
  });

  // Authoritative browser-session probe. Public health/provider endpoints cannot
  // be used to infer authentication state.
  fastify.get(
    '/api/admin/session',
    { preHandler: requireAdmin({ roles: ['admin', 'viewer', 'voice'], csrf: false }) },
    async (request) => {
      const claims = request.user as SessionClaims;
      return { authenticated: true, username: claims.username, role: claims.role };
    },
  );

  return { requireAdmin };
}

/**
 * On first run, if no admin users exist, create the bootstrap admin from env
 * (`CANVAS_CORE_ADMIN_USER` / `CANVAS_CORE_ADMIN_PASSWORD`). Emits a loud warning
 * when the defaults are in use. Never commits real credentials to source.
 */
export async function bootstrapAdmin(config: CoreConfig, repo: AuthRepository): Promise<void> {
  const count = await repo.countAdmins();
  if (count > 0) return;
  const usingDefaults =
    config.adminUser === 'admin' || config.adminPassword === 'changeme';
  const hash = hashPassword(config.adminPassword);
  await repo.createAdmin(config.adminUser, hash, 'admin');
  if (usingDefaults) {
    console.warn(
      '[core][auth] WARNING: created default bootstrap admin ' +
        `("${config.adminUser}" / "${config.adminPassword}"). ` +
        'Override CANVAS_CORE_ADMIN_USER / CANVAS_CORE_ADMIN_PASSWORD before any non-dev deployment.',
    );
  } else {
    console.log(`[core][auth] created bootstrap admin "${config.adminUser}"`);
  }
}

// Augment Fastify's request.user with our claims.
declare module '@fastify/jwt' {
  interface FastifyJWT {
    user: SessionClaims;
  }
}
