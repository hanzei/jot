import type { ComponentPropsWithoutRef, HTMLAttributes } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import rehypeSanitize from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';

type MarkdownVariant = 'preview' | 'card';

interface NoteMarkdownProps {
  content: string;
  variant: MarkdownVariant;
  className?: string;
}

const joinClasses = (...classes: Array<string | undefined>) => classes.filter(Boolean).join(' ');

const createPreviewHeading =
  (Tag: 'h1' | 'h2' | 'h3' | 'h4', className: string) => {
    const PreviewHeading = ({ node, children, ...props }: ComponentPropsWithoutRef<typeof Tag> & { node?: unknown }) => {
      void node;
      return (
      <Tag {...props} className={className}>
        {children}
      </Tag>
      );
    };

    PreviewHeading.displayName = `${Tag.toUpperCase()}PreviewHeading`;
    return PreviewHeading;
  };

const createCardHeading =
  (className: string) => {
    const CardHeading = ({ node, children, ...props }: HTMLAttributes<HTMLParagraphElement> & { node?: unknown }) => {
      void node;
      return (
      <p {...props} className={className}>
        {children}
      </p>
      );
    };

    CardHeading.displayName = 'CardMarkdownHeading';
    return CardHeading;
  };

const createMarkdownComponents = (variant: MarkdownVariant): Components => {
  const compact = variant === 'card';

  return {
    h1:
      variant === 'preview'
        ? createPreviewHeading('h1', 'mt-1 mb-2 text-lg font-semibold leading-tight text-gray-900 dark:text-white')
        : createCardHeading('my-1 font-black leading-snug text-gray-950 dark:text-white'),
    h2:
      variant === 'preview'
        ? createPreviewHeading('h2', 'mt-1 mb-2 text-base font-semibold leading-tight text-gray-900 dark:text-white')
        : createCardHeading('my-1 font-black leading-snug text-gray-950 dark:text-white'),
    h3:
      variant === 'preview'
        ? createPreviewHeading('h3', 'mt-1 mb-2 text-sm font-semibold leading-tight text-gray-900 dark:text-white')
        : createCardHeading('my-1 font-black leading-snug text-gray-950 dark:text-white'),
    h4:
      variant === 'preview'
        ? createPreviewHeading('h4', 'mt-1 mb-2 text-sm font-medium uppercase tracking-wide text-gray-700 dark:text-gray-200')
        : createCardHeading('my-1 font-black leading-snug text-gray-950 dark:text-white'),
    p: ({ children }) => (
      <p className={joinClasses(compact ? 'my-1 leading-snug' : 'my-2 leading-relaxed', 'break-words text-gray-800 dark:text-gray-100')}>
        {children}
      </p>
    ),
    strong: ({ children }) => (
      <strong className={joinClasses(variant === 'card' ? 'font-extrabold text-gray-950 dark:text-white' : 'font-semibold text-gray-900 dark:text-white')}>
        {children}
      </strong>
    ),
    em: ({ children }) => <em className="italic">{children}</em>,
    del: ({ children }) => <del className="opacity-80">{children}</del>,
    ul: ({ children }) => (
      <ul className={joinClasses(compact ? 'my-1 space-y-0.5 pl-5' : 'my-2 space-y-1 pl-5', 'list-disc')}>
        {children}
      </ul>
    ),
    ol: ({ children }) => (
      <ol className={joinClasses(compact ? 'my-1 space-y-0.5 pl-5' : 'my-2 space-y-1 pl-5', 'list-decimal')}>
        {children}
      </ol>
    ),
    li: ({ children }) => <li className="break-words leading-relaxed marker:text-gray-500 dark:marker:text-gray-400">{children}</li>,
    blockquote: ({ children }) => (
      <blockquote className={joinClasses(compact ? 'my-1 pl-3' : 'my-2 pl-3', 'border-l-2 border-black/15 text-gray-700 italic dark:border-white/20 dark:text-gray-200')}>
        {children}
      </blockquote>
    ),
    hr: () => <hr className={joinClasses(compact ? 'my-2' : 'my-3', 'border-0 border-t border-black/15 dark:border-white/15')} />,
    pre: ({ children }) => (
      <pre className={joinClasses(compact ? 'my-1.5 p-2 text-xs' : 'my-2 p-3 text-sm', 'overflow-x-auto rounded-md bg-black/8 text-gray-900 dark:bg-black/30 dark:text-gray-100')}>
        {children}
      </pre>
    ),
    code: ({ inline, children }: ComponentPropsWithoutRef<'code'> & { inline?: boolean }) => {
      if (inline) {
        return (
          <code className="rounded bg-black/8 px-1 py-0.5 font-mono text-[0.85em] text-gray-900 dark:bg-black/30 dark:text-gray-100">
            {children}
          </code>
        );
      }

      return <code className="font-mono whitespace-pre-wrap break-words">{children}</code>;
    },
    a: ({ href, children }) => {
      const className = 'font-medium text-blue-700 underline decoration-blue-500/60 underline-offset-2 dark:text-blue-300';

      if (variant === 'card') {
        return (
          <span className={joinClasses(className, 'pointer-events-none')}>
            {children}
          </span>
        );
      }

      return (
        <a
          href={href}
          target="_blank"
          rel="noreferrer noopener"
          className={className}
        >
          {children}
        </a>
      );
    },
    img: ({ alt }) => (alt ? <span className="italic text-gray-500 dark:text-gray-400">[{alt}]</span> : null),
    input: ({ node, type, ...props }: ComponentPropsWithoutRef<'input'> & { node?: unknown }) => {
      void node;
      if (type === 'checkbox') {
        return null;
      }

      return <input type={type} {...props} />;
    },
  };
};

export default function NoteMarkdown({ content, variant, className }: NoteMarkdownProps) {
  return (
    <div className={className}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeSanitize]}
        components={createMarkdownComponents(variant)}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
