import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import { separateListTrailers } from "../../lib/markdownText";

// Pure, local, deterministic Markdown -> React rendering for AI answer text (both the plain-text
// deterministic query-engine answers (line-oriented text, clarifications, refusals) share this
// one renderer). No network call, no AI call, no external service - this is a presentation-only transform
// of text the backend already returned; it never changes, re-requests or re-derives that text.
//
// Security: react-markdown does NOT execute raw HTML embedded in the source text (it renders angle
// brackets as literal escaped characters) unless the rehype-raw plugin is added - it is deliberately NOT
// added here. No dangerouslySetInnerHTML is used anywhere in this file. Links go through react-markdown's
// built-in URL sanitizer (strips javascript:/data: and other unsafe schemes) before this component ever
// sees them, and are additionally forced to open safely (rel="noopener noreferrer").
const COMPONENTS = {
  h1: ({ children }) => <h3 className="mt-3 mb-1.5 text-[15px] font-semibold text-ink-900 first:mt-0">{children}</h3>,
  h2: ({ children }) => <h3 className="mt-3 mb-1.5 text-[14.5px] font-semibold text-ink-900 first:mt-0">{children}</h3>,
  h3: ({ children }) => <h4 className="mt-2.5 mb-1 text-[13.5px] font-semibold text-ink-900 first:mt-0">{children}</h4>,
  h4: ({ children }) => <h4 className="mt-2 mb-1 text-[13.5px] font-semibold text-ink-800 first:mt-0">{children}</h4>,
  p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
  strong: ({ children }) => <strong className="font-semibold text-ink-900">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  ul: ({ children }) => <ul className="mb-2 ml-4 list-disc space-y-0.5 last:mb-0">{children}</ul>,
  ol: ({ children }) => <ol className="mb-2 ml-4 list-decimal space-y-0.5 last:mb-0">{children}</ol>,
  li: ({ children }) => <li className="pl-0.5">{children}</li>,
  hr: () => <hr className="my-2.5 border-surface-border" />,
  blockquote: ({ children }) => (
    <blockquote className="mb-2 border-l-2 border-brand-200 pl-2.5 text-ink-500 last:mb-0">{children}</blockquote>
  ),
  // No embedded images in answers: a sanitised-away URL leaves <img src="">, which makes the browser
  // re-request the page. Show the alt text only.
  img: ({ alt }) => (alt ? <span className="text-ink-500">[{alt}]</span> : null),
  a: ({ children, href }) => (
    <a href={href} target="_blank" rel="noopener noreferrer" className="text-brand-600 underline hover:text-brand-700">
      {children}
    </a>
  ),
  // react-markdown v10 no longer tells `code` whether it is inline; inline styling is the default and a
  // fenced block's inner <code> is reset by the `pre` wrapper below.
  code: ({ children }) => (
    <code className="rounded bg-white/70 px-1 py-0.5 font-mono text-[12px] text-ink-800">{children}</code>
  ),
  pre: ({ children }) => (
    <pre className="mb-2 overflow-x-auto rounded-lg bg-white/70 p-2.5 text-[12px] last:mb-0 [&_code]:bg-transparent [&_code]:p-0">
      {children}
    </pre>
  ),
  table: ({ children }) => (
    <div className="mb-2 overflow-x-auto rounded-lg border border-surface-border last:mb-0">
      <table className="w-full min-w-max border-collapse text-[12.5px]">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-surface-alt">{children}</thead>,
  tbody: ({ children }) => <tbody>{children}</tbody>,
  tr: ({ children }) => <tr className="border-t border-surface-border first:border-t-0">{children}</tr>,
  // `style` here is react-markdown/remark-gfm's own alignment output, read straight from the source
  // Markdown's `---:` / `:---` column syntax - never guessed or inferred from cell content.
  th: ({ children, style }) => (
    <th style={style} className="whitespace-nowrap px-3 py-1.5 text-left font-medium text-ink-700">
      {children}
    </th>
  ),
  td: ({ children, style }) => (
    <td style={style} className="px-3 py-1.5 align-top break-words text-ink-800">
      {children}
    </td>
  ),
};

// remark-breaks: the deterministic query engine's answers are line-oriented plain text (one figure/row/note
// per line, joined with "\n"), not blank-line-separated Markdown paragraphs. Without it CommonMark would fold
// those lines into one run-on paragraph (and a "Total:" line right after a numbered list would be swallowed
// into the last list item as a lazy continuation). It only affects soft line breaks inside paragraphs -
// tables, lists and headings from real Markdown answers parse exactly as before.
const REMARK_PLUGINS = [remarkGfm, remarkBreaks];

export default function MarkdownMessage({ text }) {
  if (!text) return null;
  return (
    <div className="text-[13.5px] leading-relaxed">
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={COMPONENTS}>
        {separateListTrailers(text)}
      </ReactMarkdown>
    </div>
  );
}
