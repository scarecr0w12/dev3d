/**
 * Markdown-lite renderer for model output.
 *
 * Artifacts, stage summaries and turn text are markdown, and they arrive with
 * untrusted content. Rather than ship a markdown library (no new dependencies
 * allowed) and rather than inject HTML, this parses the small subset the office
 * actually produces into React elements: headings, paragraphs, fenced code,
 * lists, blockquotes, rules, plus inline code, bold, italic and links.
 *
 * Anything it does not understand is rendered as plain text - never as markup.
 */

import { Fragment } from 'react';
import type { ReactNode } from 'react';

const INLINE_PATTERN = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\n]+\*)|(\[[^\]\n]+\]\([^()\s]+\))/g;

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  let index = 0;
  INLINE_PATTERN.lastIndex = 0;
  let match = INLINE_PATTERN.exec(text);
  while (match !== null) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    const token = match[0];
    const key = `${keyPrefix}-n${index}`;
    index += 1;
    if (token.startsWith('`')) {
      nodes.push(
        <code className="md-code" key={key}>
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith('**')) {
      nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith('*')) {
      nodes.push(<em key={key}>{token.slice(1, -1)}</em>);
    } else {
      const label = token.slice(1, token.indexOf(']'));
      const href = token.slice(token.indexOf('(') + 1, -1);
      nodes.push(
        <a key={key} href={href} target="_blank" rel="noreferrer noopener">
          {label}
        </a>,
      );
    }
    last = match.index + token.length;
    match = INLINE_PATTERN.exec(text);
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

interface Block {
  kind: 'paragraph' | 'heading' | 'code' | 'list' | 'quote' | 'rule';
  level: number;
  lang: string;
  lines: string[];
  ordered: boolean;
}

function toBlocks(text: string): Block[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let current: Block | null = null;

  const flush = (): void => {
    if (current) {
      blocks.push(current);
      current = null;
    }
  };

  for (const line of lines) {
    const fence = /^```(.*)$/.exec(line);
    if (fence && (current === null || current.kind !== 'code')) {
      flush();
      current = { kind: 'code', level: 0, lang: (fence[1] ?? '').trim(), lines: [], ordered: false };
      continue;
    }
    if (current && current.kind === 'code') {
      if (fence) {
        flush();
        continue;
      }
      current.lines.push(line);
      continue;
    }

    if (line.trim().length === 0) {
      flush();
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      blocks.push({ kind: 'heading', level: (heading[1] ?? '#').length, lang: '', lines: [heading[2] ?? ''], ordered: false });
      continue;
    }

    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      flush();
      blocks.push({ kind: 'rule', level: 0, lang: '', lines: [], ordered: false });
      continue;
    }

    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) {
      if (current && current.kind === 'quote') current.lines.push(quote[1] ?? '');
      else {
        flush();
        current = { kind: 'quote', level: 0, lang: '', lines: [quote[1] ?? ''], ordered: false };
      }
      continue;
    }

    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      const ordered = numbered !== null;
      if (current && current.kind === 'list' && current.ordered === ordered) {
        current.lines.push((bullet ?? numbered ?? [''])[1] ?? '');
      } else {
        flush();
        current = { kind: 'list', level: 0, lang: '', lines: [(bullet ?? numbered ?? [''])[1] ?? ''], ordered };
      }
      continue;
    }

    if (current && current.kind === 'paragraph') current.lines.push(line);
    else {
      flush();
      current = { kind: 'paragraph', level: 0, lang: '', lines: [line], ordered: false };
    }
  }
  flush();
  return blocks;
}

export interface MarkdownProps {
  text: string;
  className?: string;
  /** Keys are namespaced per instance so two panels cannot collide. */
  idPrefix?: string;
}

export function Markdown({ text, className, idPrefix = 'md' }: MarkdownProps) {
  const blocks = toBlocks(text);
  return (
    <div className={className ? `md ${className}` : 'md'}>
      {blocks.map((block, blockIndex) => {
        const key = `${idPrefix}-b${blockIndex}`;
        switch (block.kind) {
          case 'code':
            return (
              <pre className="md-pre" key={key}>
                {block.lang.length > 0 && <span className="md-lang mono">{block.lang}</span>}
                <code>{block.lines.join('\n')}</code>
              </pre>
            );
          case 'heading': {
            const content = renderInline(block.lines.join(' '), key);
            if (block.level <= 2) return <h3 className="md-h" key={key}>{content}</h3>;
            if (block.level === 3) return <h4 className="md-h" key={key}>{content}</h4>;
            return <h5 className="md-h" key={key}>{content}</h5>;
          }
          case 'rule':
            return <hr className="md-rule" key={key} />;
          case 'quote':
            return (
              <blockquote className="md-quote" key={key}>
                {renderInline(block.lines.join(' '), key)}
              </blockquote>
            );
          case 'list':
            return block.ordered ? (
              <ol className="md-list" key={key}>
                {block.lines.map((line, lineIndex) => (
                  <li key={`${key}-l${lineIndex}`}>{renderInline(line, `${key}-l${lineIndex}`)}</li>
                ))}
              </ol>
            ) : (
              <ul className="md-list" key={key}>
                {block.lines.map((line, lineIndex) => (
                  <li key={`${key}-l${lineIndex}`}>{renderInline(line, `${key}-l${lineIndex}`)}</li>
                ))}
              </ul>
            );
          case 'paragraph':
          default:
            return (
              <p className="md-p" key={key}>
                {renderInline(block.lines.join(' '), key)}
              </p>
            );
        }
      })}
    </div>
  );
}

/** One-line preview of markdown, with the syntax that would only add noise removed. */
export function plainPreview(text: string, max = 160): string {
  const collapsed = text
    .replace(/```[\s\S]*?```/g, ' [code] ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/[*_>#]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}

export function MarkdownLines({ lines, className }: { lines: readonly string[]; className?: string }) {
  return (
    <div className={className ? `md ${className}` : 'md'}>
      {lines.map((line, index) => (
        <Fragment key={`line-${index}`}>
          <p className="md-p">{renderInline(line, `l${index}`)}</p>
        </Fragment>
      ))}
    </div>
  );
}
