/**
 * Minimal auto-escaping HTML templating. Interpolated values are escaped
 * unless they are already SafeHtml, so registry content (entity identifiers,
 * entity types) can never inject markup into the page.
 */

export class SafeHtml {
  constructor(readonly value: string) {}

  toString(): string {
    return this.value;
  }
}

type Renderable = SafeHtml | string | number | boolean | null | undefined | readonly Renderable[];

const ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ESCAPES[character] ?? character);
}

function render(value: Renderable): string {
  if (value instanceof SafeHtml) {
    return value.value;
  }
  if (Array.isArray(value)) {
    return value.map((item: Renderable) => render(item)).join("");
  }
  if (value === null || value === undefined || value === false || value === true) {
    return "";
  }
  return escapeHtml(String(value));
}

export function html(strings: TemplateStringsArray, ...values: Renderable[]): SafeHtml {
  let out = strings[0] ?? "";
  values.forEach((value, index) => {
    out += render(value) + (strings[index + 1] ?? "");
  });
  return new SafeHtml(out);
}
