import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { cn } from '@/lib/cn';

/** Turns \( \) and \[ \] delimiters into $ / $$ so remark-math picks them up. */
function normalizeMath(text: string): string {
  return text
    .replace(/\\\[([\s\S]+?)\\\]/g, (_, m) => `$$${m}$$`)
    .replace(/\\\(([\s\S]+?)\\\)/g, (_, m) => `$${m}$`);
}

/** Highlights [course] / [web] provenance tags from the Philosopher. */
function tagProvenance(text: string): string {
  return text.replace(/\[(course|web)\]/gi, (_, tag: string) => `\`${tag.toLowerCase()}\``);
}

export const Markdown = memo(function Markdown({ children, className, variant = 'sky' }: { children: string; className?: string; variant?: 'sky' | 'chat' }) {
  return (
    <div className={cn('prose-sky', variant === 'chat' && 'prose-chat', className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[[rehypeKatex, { throwOnError: false, strict: 'ignore' }]]}
        components={{
          a: ({ href, children: label }) => (
            <a href={href} target="_blank" rel="noreferrer">
              {label}
            </a>
          ),
          code: ({ children: code, className: codeClass }) => {
            const text = String(code);
            if (text === 'course' || text === 'web') {
              return (
                <span
                  className={cn(
                    'mr-1 inline-flex items-center rounded-md px-1.5 py-px align-[1px] text-[10.5px] font-semibold tracking-wider uppercase',
                    text === 'course' ? 'bg-beacon-500/20 text-beacon-200' : 'bg-aurora-500/20 text-aurora-300',
                  )}
                >
                  {text}
                </span>
              );
            }
            return <code className={codeClass}>{code}</code>;
          },
        }}
      >
        {tagProvenance(normalizeMath(children))}
      </ReactMarkdown>
    </div>
  );
});
