import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { buildApp } from "../src/app.js";
import { parseSubordinates } from "../src/subordinates.js";
import { STOPLIGHT_ELEMENTS_VERSION } from "../src/ui/pages.js";
import { createFixture, ENTITY_ID, subordinateKey } from "./helpers.js";

const ISSUER = "https://issuer.test.example/issuers/a";
const DISABLED = "https://disabled.test.example";
const REPOSITORY = "https://github.com/ForkbombEu/credimi-federation";

async function site() {
  const { config, key } = await createFixture({ federationName: "Credimi Test Federation" });
  const subordinates = await parseSubordinates(
    {
      subordinates: [
        {
          entity_id: ISSUER,
          enabled: true,
          entity_types: ["openid_credential_issuer", 'x<b>&"y'],
          jwks: { keys: [(await subordinateKey()).publicJwk] },
        },
        {
          entity_id: DISABLED,
          enabled: false,
          jwks: { keys: [(await subordinateKey()).publicJwk] },
        },
      ],
    },
    { entityId: config.entityId, key },
  );
  return { app: await buildApp({ config, key, subordinates }), key, subordinates };
}

async function get(app: FastifyInstance, url: string) {
  return app.inject({ method: "GET", url });
}

const HTML_PAGES = [
  "/",
  "/inspect",
  `/inspect?sub=${encodeURIComponent(ISSUER)}`,
  "/docs",
  `/inspect?sub=${encodeURIComponent("https://stranger.test.example")}`,
];

describe("homepage", () => {
  it("shows identity, status, endpoints, keys and subordinates", async () => {
    const { app, key } = await site();
    const response = await get(app, "/");
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("text/html; charset=utf-8");
    const body = response.body;

    expect(body).toContain("<h1>Credimi Test Federation</h1>");
    expect(body).toContain(ENTITY_ID);
    expect(body).toContain("Operational");
    expect(body).toContain(`${ENTITY_ID}/.well-known/openid-federation`);
    expect(body).toContain(`${ENTITY_ID}/federation_fetch`);
    expect(body).toContain(`${ENTITY_ID}/federation_list`);
    expect(body).toContain(key.kid);
    expect(body).toContain(ISSUER);
    expect(body).toContain(DISABLED);
    expect(body).toContain("openid_credential_issuer");
    expect(body).toContain("1 enabled of 2 registered");
  });

  it("links to inspect and download statements, but not for disabled subordinates", async () => {
    const { app } = await site();
    const body = (await get(app, "/")).body;
    expect(body).toContain(`href="/inspect?sub=${encodeURIComponent(ISSUER)}"`);
    expect(body).toContain(`href="/federation_fetch?sub=${encodeURIComponent(ISSUER)}"`);
    expect(body).toContain('download="entity-configuration.jwt"');
    expect(body).not.toContain(`/inspect?sub=${encodeURIComponent(DISABLED)}`);
    expect(body).not.toContain(`/federation_fetch?sub=${encodeURIComponent(DISABLED)}`);
  });

  it("states that this is a test federation without official recognition", async () => {
    const { app } = await site();
    const body = (await get(app, "/")).body;
    expect(body).toContain("A Credimi-operated test federation");
    expect(body).toContain("not an officially recognized EUDI Wallet or IT-Wallet Trust Anchor");
  });

  it("escapes registry content", async () => {
    const { app } = await site();
    const body = (await get(app, "/")).body;
    expect(body).toContain("x&lt;b&gt;&amp;&quot;y");
    expect(body).not.toContain('x<b>&"y');
  });

  it("offers no administrative actions and no private key material", async () => {
    const { app, key } = await site();
    const body = (await get(app, "/")).body;
    expect(body).not.toMatch(/<form|method="post"/i);
    expect(body).not.toContain(key.privateJwk.d ?? "unreachable");
  });
});

describe("inspect pages", () => {
  it("decodes the Entity Configuration", async () => {
    const { app } = await site();
    const response = await get(app, "/inspect");
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("Trust Anchor Entity Configuration");
    expect(response.body).toContain("&quot;typ&quot;: &quot;entity-statement+jwt&quot;");
  });

  it("decodes a Subordinate Statement", async () => {
    const { app } = await site();
    const response = await get(app, `/inspect?sub=${encodeURIComponent(ISSUER)}`);
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain(`&quot;sub&quot;: &quot;${ISSUER}&quot;`);
  });

  it.each([DISABLED, "https://stranger.test.example"])(
    "answers 404 for %s, which has no published statement",
    async (sub) => {
      const { app } = await site();
      const response = await get(app, `/inspect?sub=${encodeURIComponent(sub)}`);
      expect(response.statusCode).toBe(404);
      expect(response.headers["content-type"]).toBe("text/html; charset=utf-8");
    },
  );
});

describe("every HTML page", () => {
  it.each(HTML_PAGES)("%s carries the Credimi shell", async (url) => {
    const { app } = await site();
    const response = await get(app, url);
    const body = response.body;

    expect(body).toContain('<link rel="icon" type="image/svg+xml" href="/favicon.svg" />');
    const brandCss = body.indexOf('href="/assets/brand/style.css"');
    const appCss = body.indexOf('href="/assets/app.css"');
    expect(brandCss).toBeGreaterThan(-1);
    expect(appCss).toBeGreaterThan(brandCss);
    expect(body).toContain('<script src="/assets/app.js" defer></script>');

    // Credimi Extras strips: top (mark + "Credimi" link) and bottom (white wordmark link).
    expect(body).toContain('class="credimi-extras-bar"');
    expect(body).toContain('class="credimi-extras-bar-footer"');
    const credimiLinks = [...body.matchAll(/<a\s[^>]*href="https:\/\/credimi\.io"[^>]*>/g)];
    expect(credimiLinks).toHaveLength(2);
    for (const [anchor] of credimiLinks) {
      expect(anchor).toMatch(/target="_blank"/);
      expect(anchor).toMatch(/rel="noopener"/);
    }
    expect(body).toContain('src="/assets/brand/logos/credimi_logo-transp_white.svg"');

    // Navigation.
    expect(body).toContain('href="/docs"');
    expect(body).toContain('href="/openapi.yaml"');
    expect(body).toContain(`href="${REPOSITORY}"`);

    expect(response.headers["content-security-policy"]).toMatch(/frame-ancestors 'none'/);
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
  });

  it.each(HTML_PAGES)("%s references only images that resolve", async (url) => {
    const { app } = await site();
    const body = (await get(app, url)).body;
    const sources = [...body.matchAll(/<img[^>]*\ssrc="([^"]+)"/g)].map((match) => match[1]);
    expect(sources.length).toBeGreaterThan(0);
    for (const source of sources) {
      const asset = await get(app, source ?? "");
      expect(asset.statusCode, source).toBe(200);
      expect(asset.headers["content-type"], source).toMatch(/^image\/svg\+xml/);
    }
  });
});

describe("/docs", () => {
  it("renders Stoplight Elements at a pinned version against the raw OpenAPI", async () => {
    const { app } = await site();
    const response = await get(app, "/docs");
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain(
      `https://unpkg.com/@stoplight/elements@${STOPLIGHT_ELEMENTS_VERSION}/web-components.min.js`,
    );
    expect(STOPLIGHT_ELEMENTS_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(response.body).toContain('apiDescriptionUrl="/openapi.yaml"');
    expect(response.body).toContain('tryItCredentialsPolicy="same-origin"');
    expect(response.headers["content-security-policy"]).toContain(
      "script-src 'self' https://unpkg.com",
    );
  });
});

describe("OpenAPI", () => {
  it("serves one OpenAPI 3.1 document as YAML and as derived JSON", async () => {
    const { app } = await site();
    const yaml = await get(app, "/openapi.yaml");
    const json = await get(app, "/openapi.json");
    expect(yaml.statusCode).toBe(200);
    expect(yaml.headers["content-type"]).toBe("application/yaml; charset=utf-8");
    expect(json.headers["content-type"]).toBe("application/json; charset=utf-8");

    const document = parse(yaml.body) as { openapi: string; servers: { url: string }[] };
    expect(document.openapi).toBe("3.1.0");
    expect(json.json()).toEqual(document);
    expect(document.servers.map((server) => server.url)).toEqual(["/", ENTITY_ID]);
  });

  it("describes every implemented API route and no HTML page", async () => {
    const { app } = await site();
    const document = parse((await get(app, "/openapi.yaml")).body) as {
      paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
    };
    expect(Object.keys(document.paths).sort()).toEqual(
      [
        "/.well-known/openid-federation",
        "/federation_fetch",
        "/federation_list",
        "/healthz",
        "/openapi.json",
        "/openapi.yaml",
      ].sort(),
    );
    for (const path of Object.keys(document.paths)) {
      expect(
        (await get(app, path === "/federation_fetch" ? `${path}?sub=${ISSUER}` : path)).statusCode,
      ).toBe(200);
    }
    const fetch = document.paths["/federation_fetch"]?.["get"]?.responses ?? {};
    expect(Object.keys(fetch)).toEqual(expect.arrayContaining(["200", "400", "404"]));
    expect(JSON.stringify(fetch["200"])).toContain("application/entity-statement+jwt");
  });
});

describe("brand assets", () => {
  async function filesUnder(dir: string): Promise<string[]> {
    const entries = await readdir(dir, { recursive: true, withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => relative(dir, join(entry.parentPath, entry.name)))
      .sort();
  }

  it("installs a byte-identical runtime copy of every file in brand/", async () => {
    const canonical = await filesUnder("brand");
    expect(await filesUnder("public/brand")).toEqual(canonical);
    for (const file of canonical) {
      const original = await readFile(join("brand", file));
      expect((await readFile(join("public/brand", file))).equals(original), file).toBe(true);
    }
  });

  it("keeps every logo copy at the SHA-256 pinned in DESIGN.md §1", async () => {
    const design = await readFile("DESIGN.md", "utf8");
    const pins = [...design.matchAll(/\| `brand\/logos\/([^`]+)` \| `([0-9a-f]{64})` \|/g)];
    expect(pins).toHaveLength(4);
    for (const [, name, sha256] of pins) {
      const copy = await readFile(join("public/brand/logos", name ?? ""));
      expect(createHash("sha256").update(copy).digest("hex"), name).toBe(sha256);
    }
  });

  it("serves the favicon as the unchanged credimi_logo.svg", async () => {
    const { app } = await site();
    const response = await get(app, "/favicon.svg");
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toMatch(/^image\/svg\+xml/);
    expect(response.rawPayload.equals(await readFile("brand/logos/credimi_logo.svg"))).toBe(true);
  });

  it.each([
    ["/assets/brand/style.css", /^text\/css/],
    ["/assets/app.css", /^text\/css/],
    ["/assets/app.js", /javascript/],
    ["/assets/brand/fonts/InterVariable.ttf", /^font\/ttf/],
    ["/assets/brand/fonts/SourceCodeProVariable.ttf", /^font\/ttf/],
    ["/assets/brand/logos/credimi_logo_negative.svg", /^image\/svg\+xml/],
  ])("serves %s", async (url, type) => {
    const { app } = await site();
    const response = await get(app, url);
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toMatch(type);
  });

  it("emits the styled console signature from the page script", async () => {
    const script = await readFile("public/app.js", "utf8");
    expect(script).toMatch(/console\.log\(\s*"%cCredimi%c/);
  });
});
