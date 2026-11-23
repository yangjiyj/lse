import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export function Markdown({ content }: { content: string }) {
  return (
    <div className="text-sm leading-relaxed text-foreground">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ ...p }) => (
            <h1 className="mb-3 mt-5 text-xl font-bold tracking-tight first:mt-0" {...p} />
          ),
          h2: ({ ...p }) => (
            <h2
              className="mb-2 mt-5 border-b border-border pb-1 text-lg font-semibold first:mt-0"
              {...p}
            />
          ),
          h3: ({ ...p }) => <h3 className="mb-2 mt-4 text-base font-semibold first:mt-0" {...p} />,
          h4: ({ ...p }) => <h4 className="mb-1 mt-3 text-sm font-semibold" {...p} />,
          p: ({ ...p }) => <p className="my-2" {...p} />,
          ul: ({ ...p }) => <ul className="my-2 list-disc space-y-1 pl-5" {...p} />,
          ol: ({ ...p }) => <ol className="my-2 list-decimal space-y-1 pl-5" {...p} />,
          li: ({ ...p }) => <li className="leading-relaxed" {...p} />,
          strong: ({ ...p }) => <strong className="font-semibold text-foreground" {...p} />,
          blockquote: ({ ...p }) => (
            <blockquote
              className="my-3 border-l-2 border-primary/40 bg-muted/40 py-1 pl-3 text-muted-foreground"
              {...p}
            />
          ),
          code: ({ ...p }) => (
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs" {...p} />
          ),
          pre: ({ ...p }) => (
            <pre
              className="my-3 overflow-x-auto rounded-md border border-border bg-muted/50 p-3 text-xs"
              {...p}
            />
          ),
          a: ({ ...p }) => <a className="text-primary underline underline-offset-2" {...p} />,
          hr: ({ ...p }) => <hr className="my-4 border-border" {...p} />,
          table: ({ ...p }) => (
            <div className="my-3 overflow-x-auto">
              <table className="w-full border-collapse text-xs" {...p} />
            </div>
          ),
          thead: ({ ...p }) => <thead className="bg-muted/60" {...p} />,
          th: ({ ...p }) => (
            <th className="border border-border px-2 py-1 text-left font-semibold" {...p} />
          ),
          td: ({ ...p }) => <td className="border border-border px-2 py-1 align-top" {...p} />,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
