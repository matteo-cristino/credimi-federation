/**
 * Fastify application. Federation endpoints are forwarded to the
 * @oidfed/authority TrustAnchor; everything else is served here.
 */
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type { TrustAnchor } from "@oidfed/authority";
import type { AppConfig } from "./config.js";
import { createTrustAnchor, FederationPath } from "./federation.js";
import type { FederationKey } from "./keys.js";

export interface AppDependencies {
  readonly config: AppConfig;
  readonly key: FederationKey;
}

export interface AppOptions {
  readonly logger?: boolean;
}

const FEDERATION_ROUTES = [
  FederationPath.EntityConfiguration,
  FederationPath.Fetch,
  FederationPath.List,
] as const;

const UNSUPPORTED_METHODS = ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;

export async function buildApp(
  deps: AppDependencies,
  options: AppOptions = {},
): Promise<FastifyInstance> {
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
  const trustAnchor = createTrustAnchor({ entityId: deps.config.entityId, key: deps.key });

  for (const path of FEDERATION_ROUTES) {
    app.get(path, (request, reply) =>
      forwardToTrustAnchor(trustAnchor, deps.config.entityId, path, request, reply),
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

  app.get("/healthz", (_request, reply) =>
    reply.header("cache-control", "no-store").send({ status: "ok" }),
  );

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
