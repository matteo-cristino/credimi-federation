/**
 * Server-rendered, read-only pages. Every page uses the same shell: Credimi
 * Extras strip, topbar, content, footer with the closing Extras strip
 * (DESIGN.md §8, §13). Brand CSS loads first, application CSS after it.
 */
import type { FederationEndpoints } from "../federation.js";
import type { Subordinate } from "../subordinates.js";
import { html, SafeHtml } from "./html.js";

export const REPOSITORY_URL = "https://github.com/ForkbombEu/credimi-federation";
const SPEC_URL = "https://openid.net/specs/openid-federation-1_0-final.html";
const CREDIMI_URL = "https://credimi.io";

/** Pinned Stoplight Elements build for /docs. */
export const STOPLIGHT_ELEMENTS_VERSION = "9.0.29";
const STOPLIGHT_BASE = `https://unpkg.com/@stoplight/elements@${STOPLIGHT_ELEMENTS_VERSION}`;
export const DOCS_SCRIPT_URL = `${STOPLIGHT_BASE}/web-components.min.js`;
export const DOCS_STYLE_URL = `${STOPLIGHT_BASE}/styles.min.css`;

export interface SiteInfo {
  readonly federationName: string;
  readonly entityId: string;
}

export interface SigningKeySummary {
  readonly kid: string;
  readonly kty: string;
  readonly crv: string | undefined;
  readonly alg: string | undefined;
}

export interface HomeModel extends SiteInfo {
  readonly endpoints: FederationEndpoints;
  readonly signingKeys: readonly SigningKeySummary[];
  readonly entityConfiguration: { readonly issuedAt: number; readonly expiresAt: number };
  readonly subordinates: readonly Subordinate[];
}

export interface InspectModel extends SiteInfo {
  readonly title: string;
  readonly subject: string;
  readonly rawUrl: string;
  readonly downloadName: string;
  readonly jwt: string;
  readonly header: unknown;
  readonly payload: unknown;
}

type Section = "home" | "docs" | "inspect";

export function inspectUrl(subject?: string): string {
  return subject === undefined ? "/inspect" : `/inspect?sub=${encodeURIComponent(subject)}`;
}

export function fetchPath(subject: string): string {
  return `/federation_fetch?sub=${encodeURIComponent(subject)}`;
}

export function homePage(model: HomeModel): string {
  const enabled = model.subordinates.filter((entry) => entry.enabled);
  const body = html`
    <section class="hero">
      <div class="hero-inner">
        <p class="eyebrow">OpenID Federation 1.0 · Trust Anchor</p>
        <h1>${model.federationName}</h1>
        <p class="entity-id"><code class="inline-code">${model.entityId}</code></p>
        <p class="hero-lead">
          This Trust Anchor publishes its own signed Entity Configuration and signed Subordinate
          Statements about the issuers, verifiers and other entities registered beneath it, so a
          wallet or relying party can assemble and verify a Trust Chain that ends here.
        </p>
        <div class="hero-actions">
          <a
            class="btn btn-primary btn-md"
            href="/.well-known/openid-federation"
            download="entity-configuration.jwt"
            >Download Entity Configuration</a
          >
          <a class="btn btn-outline btn-md" href="${inspectUrl()}">Inspect Entity Configuration</a>
        </div>
      </div>
    </section>
    <div class="container page-content">
      ${testFederationNotice()}
      <section class="page-section" aria-labelledby="status-title">
        <div class="section-header"><h2 id="status-title">Trust Anchor status</h2></div>
        <div class="card">
          <dl class="dl">
            <dt>Status</dt>
            <dd><span class="status-chip status-verifier">Operational</span></dd>
            <dt>Entity Identifier</dt>
            <dd><code>${model.entityId}</code></dd>
            <dt>Entity Configuration</dt>
            <dd>
              Issued
              <time class="mono">${formatDateTime(model.entityConfiguration.issuedAt)}</time>, valid
              until
              <time class="mono">${formatDateTime(model.entityConfiguration.expiresAt)}</time>
            </dd>
            <dt>Subordinates</dt>
            <dd>${enabled.length} enabled of ${model.subordinates.length} registered</dd>
          </dl>
        </div>
      </section>

      <section class="page-section" aria-labelledby="endpoints-title">
        <div class="section-header">
          <h2 id="endpoints-title">Federation endpoints</h2>
          <a class="see-all" href="/docs">API docs <span aria-hidden="true">↗</span></a>
        </div>
        <div class="card test-table-wrap">
          <table class="test-table stack-table">
            <thead>
              <tr>
                <th scope="col">Endpoint</th>
                <th scope="col">URL</th>
                <th scope="col">Response</th>
              </tr>
            </thead>
            <tbody>
              ${endpointRow(
                "Entity Configuration",
                model.endpoints.entityConfiguration,
                "application/entity-statement+jwt",
              )}
              ${endpointRow(
                "Fetch (federation_fetch_endpoint)",
                model.endpoints.fetch,
                "application/entity-statement+jwt",
              )}
              ${endpointRow(
                "Subordinate listing (federation_list_endpoint)",
                model.endpoints.list,
                "application/json",
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section class="page-section" aria-labelledby="keys-title">
        <div class="section-header">
          <h2 id="keys-title">
            Federation signing keys <span class="count-chip">${model.signingKeys.length}</span>
          </h2>
        </div>
        <div class="card test-table-wrap">
          <table class="test-table stack-table">
            <thead>
              <tr>
                <th scope="col">Key ID (kid)</th>
                <th scope="col">Algorithm</th>
                <th scope="col">Key type</th>
              </tr>
            </thead>
            <tbody>
              ${model.signingKeys.map(
                (key) =>
                  html`<tr>
                    <td data-label="Key ID"><code class="kid">${key.kid}</code></td>
                    <td data-label="Algorithm"><code>${key.alg ?? "—"}</code></td>
                    <td data-label="Key type">
                      <code>${key.crv === undefined ? key.kty : `${key.kty} ${key.crv}`}</code>
                    </td>
                  </tr>`,
              )}
            </tbody>
          </table>
        </div>
        <p class="section-note">
          Only public keys are published. Relying parties must not trust these keys merely because
          this page shows them: obtain the Trust Anchor's JWK Set from the federation operator over
          a separate trusted channel and compare the key IDs.
        </p>
      </section>

      <section class="page-section" aria-labelledby="subordinates-title">
        <div class="section-header">
          <h2 id="subordinates-title">
            Subordinate entities <span class="count-chip">${model.subordinates.length}</span>
          </h2>
          <a class="see-all" href="/federation_list"
            >Listing JSON <span aria-hidden="true">↗</span></a
          >
        </div>
        ${
          model.subordinates.length === 0
            ? html`<div class="card empty-state">
                <p><strong>No subordinate entities are registered yet.</strong></p>
                <p>
                  Entities join by giving the federation operator their Entity Identifier and public
                  federation keys. See the
                  <a href="${REPOSITORY_URL}#registering-a-subordinate">registration guide</a>.
                </p>
              </div>`
            : html`<div class="card test-table-wrap">
                <table class="test-table stack-table">
                  <thead>
                    <tr>
                      <th scope="col">Entity Identifier</th>
                      <th scope="col">Entity types</th>
                      <th scope="col">Status</th>
                      <th scope="col">Key IDs</th>
                      <th scope="col">Subordinate Statement</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${model.subordinates.map(subordinateRow)}
                  </tbody>
                </table>
              </div>`
        }
      </section>
    </div>
  `;
  return layout(model, { title: "Trust Anchor", section: "home", body });
}

export function inspectPage(model: InspectModel): string {
  const body = html`
    <div class="container page-content">
      <nav class="breadcrumb" aria-label="Breadcrumb"><a href="/">Home</a> / Inspect</nav>
      <p class="eyebrow">Signed Entity Statement</p>
      <h1 class="page-title">${model.title}</h1>
      <p class="entity-id"><code class="inline-code">${model.subject}</code></p>
      <div class="hero-actions">
        <a class="btn btn-primary btn-md" href="${model.rawUrl}" download="${model.downloadName}"
          >Download JWT</a
        >
        <a class="btn btn-outline btn-md" href="${model.rawUrl}">Open raw response</a>
      </div>
      <p class="section-note">
        Decoded for reading only. Verify the signature yourself with the Trust Anchor's public keys
        before relying on any claim.
      </p>
      <section class="page-section" aria-labelledby="header-title">
        <div class="section-header"><h2 id="header-title">JOSE header</h2></div>
        <pre><code>${JSON.stringify(model.header, null, 2)}</code></pre>
      </section>
      <section class="page-section" aria-labelledby="payload-title">
        <div class="section-header"><h2 id="payload-title">Claims</h2></div>
        <pre><code>${JSON.stringify(model.payload, null, 2)}</code></pre>
      </section>
      <section class="page-section" aria-labelledby="jwt-title">
        <div class="section-header"><h2 id="jwt-title">Compact JWT</h2></div>
        <pre class="jwt"><code>${model.jwt}</code></pre>
      </section>
    </div>
  `;
  return layout(model, { title: model.title, section: "inspect", body });
}

export function notFoundPage(site: SiteInfo, message: string): string {
  const body = html`
    <div class="container page-content">
      <p class="eyebrow">Not found</p>
      <h1 class="page-title">Nothing to inspect here</h1>
      <p>${message}</p>
      <p><a class="btn btn-outline btn-md" href="/">Back to the Trust Anchor</a></p>
    </div>
  `;
  return layout(site, { title: "Not found", section: "inspect", body });
}

export function docsPage(site: SiteInfo): string {
  const body = html`
    <div class="api-docs">
      <elements-api
        apiDescriptionUrl="/openapi.yaml"
        router="hash"
        layout="sidebar"
        tryItCredentialsPolicy="same-origin"
      ></elements-api>
    </div>
  `;
  return layout(site, {
    title: "API docs",
    section: "docs",
    body,
    head: html`<link rel="stylesheet" href="${DOCS_STYLE_URL}" />
      <script src="${DOCS_SCRIPT_URL}" defer></script>`,
  });
}

function layout(
  site: SiteInfo,
  page: { title: string; section: Section; body: SafeHtml; head?: SafeHtml },
): string {
  return html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${page.title} · ${site.federationName}</title>
        <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
        <link rel="stylesheet" href="/assets/brand/style.css" />
        <link rel="stylesheet" href="/assets/app.css" />
        ${page.head}
        <script src="/assets/app.js" defer></script>
      </head>
      <body>
        ${extrasTopStrip()}
        <header class="topbar">
          <div class="topbar-inner">
            <a class="topbar-logo" href="/">
              <img src="/assets/brand/logos/credimi_logo-transp.svg" alt="Credimi" />
            </a>
            <nav aria-label="Main">
              <ul class="topbar-nav">
                ${navLink("/", "Home", page.section === "home")}
                ${navLink("/docs", "API docs", page.section === "docs")}
                <li><a href="/openapi.yaml">OpenAPI</a></li>
                <li><a href="${REPOSITORY_URL}" rel="noopener" target="_blank">Repository</a></li>
              </ul>
            </nav>
          </div>
        </header>
        <main id="main">${page.body}</main>
        ${footer()}
      </body>
    </html>`.value;
}

function navLink(href: string, label: string, active: boolean): SafeHtml {
  return active
    ? html`<li><a class="nav-active" href="${href}" aria-current="page">${label}</a></li>`
    : html`<li><a href="${href}">${label}</a></li>`;
}

function testFederationNotice(): SafeHtml {
  return html`<aside class="alert alert-info" role="note" aria-labelledby="notice-title">
    <svg
      class="alert-icon"
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" />
      <path d="M12 16v-4" />
      <path d="M12 8h.01" />
    </svg>
    <div>
      <p class="alert-title" id="notice-title">A Credimi-operated test federation</p>
      <p>
        This Trust Anchor is operated by Credimi for development and interoperability testing. It is
        not an officially recognized EUDI Wallet or IT-Wallet Trust Anchor, is not listed in any EU
        or national trusted list, and membership here confers no accreditation or certification.
      </p>
    </div>
  </aside>`;
}

function endpointRow(label: string, url: string, mediaType: string): SafeHtml {
  return html`<tr>
    <td data-label="Endpoint">${label}</td>
    <td data-label="URL"><code class="endpoint-url">${url}</code></td>
    <td data-label="Response"><code>${mediaType}</code></td>
  </tr>`;
}

function subordinateRow(subordinate: Subordinate): SafeHtml {
  const statementLinks = subordinate.enabled
    ? html`<a href="${inspectUrl(subordinate.entityId)}">Inspect</a> ·
        <a
          href="${fetchPath(subordinate.entityId)}"
          download="${downloadName(subordinate.entityId)}"
          >Download</a
        >`
    : html`<span class="text-muted">Not published</span>`;
  return html`<tr>
    <td data-label="Entity Identifier"><code class="entity-ref">${subordinate.entityId}</code></td>
    <td data-label="Entity types">
      ${
        subordinate.entityTypes.length === 0
          ? html`<span class="text-muted">—</span>`
          : subordinate.entityTypes.map(
              (type) => html`<code class="inline-code entity-type">${type}</code> `,
            )
      }
    </td>
    <td data-label="Status">
      ${
        subordinate.enabled
          ? html`<span class="status-chip status-verifier">Enabled</span>`
          : html`<span class="badge badge-neutral">Disabled</span>`
      }
    </td>
    <td data-label="Key IDs">
      ${subordinate.jwks.keys.map((key) => html`<code class="kid">${key.kid}</code> `)}
    </td>
    <td data-label="Statement">${statementLinks}</td>
  </tr>`;
}

export function downloadName(entityId: string): string {
  const slug = entityId
    .replace(/^https:\/\//, "")
    .replace(/[^A-Za-z0-9.-]+/g, "_")
    .replace(/_+$/, "");
  return `${slug}.subordinate-statement.jwt`;
}

function extrasTopStrip(): SafeHtml {
  return html`<div class="credimi-extras-bar">
    <div class="credimi-extras-bar-inner">
      <img
        class="credimi-extras-mark"
        src="/assets/brand/logos/credimi_logo.svg"
        alt=""
        aria-hidden="true"
        width="16"
        height="16"
      />
      This app is part of <strong>Credimi Extras</strong>. Automate all your EUDI testing with
      <a href="${CREDIMI_URL}" target="_blank" rel="noopener"><strong>Credimi</strong></a>
    </div>
  </div>`;
}

function footer(): SafeHtml {
  return html`<footer class="footer">
    <div class="footer-inner">
      <div class="footer-content">
        <div class="footer-brand">
          <img
            class="footer-mark"
            src="/assets/brand/logos/credimi_logo_negative.svg"
            alt="Credimi"
            width="40"
            height="40"
          />
          <p>
            An OpenID Federation 1.0 Trust Anchor for Credimi development and interoperability
            testing.
          </p>
        </div>
        <div class="footer-links">
          <div class="footer-col">
            <h5>Federation</h5>
            <a href="/.well-known/openid-federation">Entity Configuration</a>
            <a href="/federation_list">Subordinate listing</a>
          </div>
          <div class="footer-col">
            <h5>Project</h5>
            <a href="/docs">API docs</a>
            <a href="/openapi.yaml">OpenAPI</a>
            <a href="${REPOSITORY_URL}" target="_blank" rel="noopener">Repository</a>
          </div>
          <div class="footer-col">
            <h5>Specification</h5>
            <a href="${SPEC_URL}" target="_blank" rel="noopener">OpenID Federation 1.0</a>
          </div>
        </div>
      </div>
    </div>
    <div class="footer-sub-bar">Proudly developed by Forkbomb BV</div>
    <div class="credimi-extras-bar-footer">
      <div class="credimi-extras-bar-inner">
        This app is part of <strong>Credimi Extras</strong>. Automate all your EUDI testing with
        <a class="credimi-extras-wordmark-link" href="${CREDIMI_URL}" target="_blank" rel="noopener"
          ><img
            class="credimi-extras-wordmark"
            src="/assets/brand/logos/credimi_logo-transp_white.svg"
            alt="Credimi"
        /></a>
      </div>
    </div>
  </footer>`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** DESIGN.md §3 date + time format (`DD MMM YYYY, HH:mm`, 24h), in UTC. */
export function formatDateTime(epochSeconds: number): string {
  const date = new Date(epochSeconds * 1000);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return (
    `${pad(date.getUTCDate())} ${MONTHS[date.getUTCMonth()] ?? ""} ${String(date.getUTCFullYear())}, ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`
  );
}
