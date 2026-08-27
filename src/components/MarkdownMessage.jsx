import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

const ALLOWED_ELEMENTS = [
  "a", "blockquote", "br", "code", "del", "em", "h1", "h2", "h3", "h4", "h5", "h6", "hr",
  "li", "ol", "p", "pre", "strong", "table", "tbody", "td", "th", "thead", "tr", "ul",
];
const MARKDOWN_PLUGINS = [remarkGfm];

function isHttpsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

function openInSystemBrowser(event, href) {
  if (!window.__TAURI_INTERNALS__) return;
  event.preventDefault();
  void import("@tauri-apps/plugin-opener").then(({ openUrl }) => openUrl(href)).catch(() => {});
}

function MarkdownLink({ node: _node, href, children, ...props }) {
  if (!isHttpsUrl(href)) return <span className="assistant-link-disabled">{children}</span>;
  return <a {...props} href={href} target="_blank" rel="noopener noreferrer" onClick={(event) => openInSystemBrowser(event, href)}>{children}</a>;
}

function MarkdownTable({ node: _node, children, ...props }) {
  return <div className="assistant-table-scroll"><table {...props}>{children}</table></div>;
}

const MARKDOWN_COMPONENTS = { a: MarkdownLink, table: MarkdownTable };

export default function MarkdownMessage({ text }) {
  return (
    <div className="assistant-content">
      <Markdown
        allowedElements={ALLOWED_ELEMENTS}
        components={MARKDOWN_COMPONENTS}
        remarkPlugins={MARKDOWN_PLUGINS}
        skipHtml
        unwrapDisallowed
      >
        {text}
      </Markdown>
    </div>
  );
}
