/**
 * Fastify application. Federation endpoints are forwarded to the
 * @oidfed/authority TrustAnchor; the website, API description, health check
 * and static assets are served here.
 */
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import type { TrustAnchor } from "@oidfed/authority";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { decodeJwt, decodeProtectedHeader } from "jose";
import type { AppConfig } from "./config.js";
import { createTrustAnchor, FederationPath, federationEndpoints } from "./federation.js";
import type { FederationKey } from "./keys.js";
import { loadOpenApi } from "./openapi.js";
import type { Subordinate } from "./subordinates.js";
import {
  docsPage,
  DOCS_SCRIPT_URL,
  downloadName,
  fetchPath,
  homePage,
  inspectPage,
  notFoundPage,
  type SiteInfo,
} from "./ui/pages.js";

export interface AppDependencies {
  readonly config: AppConfig;
  readonly key: FederationKey;
  readonly subordinates: readonly Subordinate[];
}

export interface AppOptions {
  readonly logger?: boolean;
}

const PUBLIC_DIR = fileURLToPath(new URL("../public/", import.meta.url));

const FEDERATION_ROUTES = [
  FederationPath.EntityConfiguration,
  FederationPath.Fetch,
  FederationPath.List,
] as const;

const UNSUPPORTED_METHODS = ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;

const PAGE_CSP = [
  "default-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

export async function buildApp(
  deps: AppDependencies,
  options: AppOptions = {},
): Promise<FastifyInstance> {
  const { config } = deps;
  const app = Fastify({
    logger: options.logger ?? false,
    // The service never reads Host or X-Forwarded-* to build URLs, so proxy
    // headers are deliberately not trusted.
    trustProxy: false,
  });
  // No route reads a request body. Accept any media type without parsing so
  // that a request with an unexpected method gets the 405 below instead of a
  // 415 about a body nobody would read.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser("*", (_request, _payload, done) => {
    done(null);
  });

  const trustAnchor = await createTrustAnchor({
    entityId: config.entityId,
    key: deps.key,
    subordinates: deps.subordinates,
  });
  const openApi = await loadOpenApi(config.entityId);
  const site: SiteInfo = { federationName: config.federationName, entityId: config.entityId };
  const docsCsp = [
    "default-src 'self'",
    `script-src 'self' ${new URL(DOCS_SCRIPT_URL).origin}`,
    `style-src 'self' 'unsafe-inline' ${new URL(DOCS_SCRIPT_URL).origin}`,
    "img-src 'self' data:",
    "font-src 'self' data:",
    `connect-src 'self' ${config.entityId}`,
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");

  // --- OpenID Federation endpoints ---
  for (const path of FEDERATION_ROUTES) {
    app.get(path, (request, reply) =>
      forwardToTrustAnchor(trustAnchor, config.entityId, path, request, reply),
    );
    app.route({
      method: [...UNSUPPORTED_METHODS],
      url: path,
      handler: (_request, reply) =>
        federationError(
          reply.header("allow", "GET, HEAD"),
          405,
          "invalid_request",
          `${path} only supports the GET method.`,
        ),
    });
  }

  // --- Operations ---
  app.get("/healthz", (_request, reply) =>
    reply.header("cache-control", "no-store").send({ status: "ok" }),
  );
  app.get("/openapi.yaml", (_request, reply) =>
    reply.type("application/yaml; charset=utf-8").send(openApi.yaml),
  );
  app.get("/openapi.json", (_request, reply) =>
    reply.type("application/json; charset=utf-8").send(openApi.json),
  );

  // --- Website ---
  await app.register(fastifyStatic, { root: PUBLIC_DIR, prefix: "/assets/" });
  app.get("/favicon.svg", (_request, reply) =>
    reply.type("image/svg+xml").sendFile("brand/logos/credimi_logo.svg"),
  );

  app.get("/", async (_request, reply) => {
    const entityConfiguration = decodeJwt(await trustAnchor.getEntityConfiguration());
    return sendPage(
      reply,
      200,
      PAGE_CSP,
      homePage({
        ...site,
        endpoints: federationEndpoints(config.entityId),
        signingKeys: [
          {
            kid: deps.key.kid,
            kty: deps.key.publicJwk.kty ?? "",
            crv: deps.key.publicJwk.crv,
            alg: deps.key.publicJwk.alg,
          },
        ],
        entityConfiguration: {
          issuedAt: entityConfiguration.iat ?? 0,
          expiresAt: entityConfiguration.exp ?? 0,
        },
        subordinates: deps.subordinates,
      }),
    );
  });

  app.get("/inspect", async (request, reply) => {
    const { sub } = request.query as { sub?: unknown };
    if (sub === undefined) {
      const jwt = await trustAnchor.getEntityConfiguration();
      return sendPage(
        reply,
        200,
        PAGE_CSP,
        inspectPage({
          ...site,
          title: "Trust Anchor Entity Configuration",
          subject: config.entityId,
          rawUrl: FederationPath.EntityConfiguration,
          downloadName: "entity-configuration.jwt",
          jwt,
          header: decodeProtectedHeader(jwt),
          payload: decodeJwt(jwt),
        }),
      );
    }
    if (typeof sub !== "string") {
      return sendPage(reply, 400, PAGE_CSP, notFoundPage(site, "Give exactly one sub parameter."));
    }
    // Same code path as the public fetch endpoint, so the page shows exactly
    // what a federation participant would receive.
    const response = await trustAnchor.handleRequest(
      new Request(new URL(fetchPath(sub), config.entityId), { method: "GET" }),
    );
    if (response.status !== 200) {
      const { error_description: description } = (await response.json()) as {
        error_description?: string;
      };
      return sendPage(
        reply,
        response.status === 400 ? 400 : 404,
        PAGE_CSP,
        notFoundPage(site, `No Subordinate Statement for ${sub}: ${description ?? "unknown"}.`),
      );
    }
    const jwt = await response.text();
    return sendPage(
      reply,
      200,
      PAGE_CSP,
      inspectPage({
        ...site,
        title: "Subordinate Statement",
        subject: sub,
        rawUrl: fetchPath(sub),
        downloadName: downloadName(sub),
        jwt,
        header: decodeProtectedHeader(jwt),
        payload: decodeJwt(jwt),
      }),
    );
  });

  app.get("/docs", (_request, reply) => sendPage(reply, 200, docsCsp, docsPage(site)));

  // --- Fallbacks ---
  app.setNotFoundHandler((request, reply) =>
    federationError(reply, 404, "not_found", `No resource at ${request.url.split("?")[0] ?? ""}.`),
  );

  app.setErrorHandler((error: { statusCode?: number; message: string }, request, reply) => {
    const status = error.statusCode ?? 500;
    if (status >= 400 && status < 500) {
      // Malformed requests rejected by Fastify itself (bad body, bad URL).
      return federationError(reply, status, "invalid_request", error.message);
    }
    request.log.error({ err: error }, "request failed");
    return federationError(reply, 500, "server_error", "The server could not handle the request.");
  });

  await app.ready();
  return app;
}

/**
 * Rebuilds the request URL from the configured Entity Identifier and the
 * matched route path. Only the query string is taken from the client, so an
 * absolute-form request target or a spoofed Host header cannot change the
 * URL the library sees.
 */
async function forwardToTrustAnchor(
  trustAnchor: TrustAnchor,
  entityId: string,
  path: string,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply> {
  const target = new URL(path, entityId);
  const queryStart = request.url.indexOf("?");
  target.search = queryStart === -1 ? "" : request.url.slice(queryStart);

  const response = await trustAnchor.handleRequest(new Request(target, { method: "GET" }));
  reply.code(response.status);
  response.headers.forEach((value, name) => {
    reply.header(name, value);
  });
  return reply.send(await response.text());
}

function sendPage(reply: FastifyReply, status: number, csp: string, body: string): FastifyReply {
  return reply
    .code(status)
    .header("content-security-policy", csp)
    .header("x-content-type-options", "nosniff")
    .header("referrer-policy", "no-referrer")
    .header("x-frame-options", "DENY")
    .header("cache-control", "no-store")
    .type("text/html; charset=utf-8")
    .send(body);
}

/** OpenID Federation 1.0 §8.9 error response. */
function federationError(
  reply: FastifyReply,
  status: number,
  error: string,
  description: string,
): FastifyReply {
  return reply
    .code(status)
    .header("cache-control", "no-store")
    .type("application/json")
    .send({ error, error_description: description });
}
