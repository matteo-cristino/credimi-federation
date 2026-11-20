// Styled console signature. Colours are read from the brand tokens at runtime
// so the signature cannot drift from brand/style.css.
const tokens = getComputedStyle(document.documentElement);
const token = (name) => tokens.getPropertyValue(name).trim();

console.log(
  "%cCredimi%c credimi-federation · OpenID Federation 1.0 Trust Anchor",
  `background:${token("--brand-primary")};color:${token("--fg-on-primary")};` +
    "padding:4px 8px;border-radius:4px 0 0 4px;font-weight:700",
  `background:${token("--brand-secondary")};color:${token("--brand-primary")};` +
    "padding:4px 8px;border-radius:0 4px 4px 0;font-weight:500",
);
