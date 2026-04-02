import React, { memo } from 'react';

const URL_SPLIT_REGEX = /(https?:\/\/[^\s<>"{}|\\^`[\]]+)/gi;
const URL_TEST_REGEX = /^https?:\/\//i;

interface LinkTextProps {
  text: string;
}

function LinkText({ text }: LinkTextProps) {
  const parts = text.split(URL_SPLIT_REGEX);

  return (
    <>
      {parts.map((part, i) => {
        if (!URL_TEST_REGEX.test(part)) {
          return <React.Fragment key={i}>{part}</React.Fragment>;
        }
        const m = part.match(/^(https?:\/\/\S+?)([).,!?:;]+)?$/i);
        let url = m?.[1] ?? part;
        let trailing = m?.[2] ?? '';
        // Reabsorb ')' that close an unmatched '(' in the URL so that
        // URLs with balanced parentheses (e.g. Wikipedia) are not broken.
        let open = (url.match(/\(/g)?.length ?? 0) - (url.match(/\)/g)?.length ?? 0);
        while (open > 0 && trailing.startsWith(')')) {
          url += ')';
          trailing = trailing.slice(1);
          open--;
        }
        return (
          <React.Fragment key={i}>
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`${url} (opens in new tab)`}
              className="text-blue-600 dark:text-blue-400 underline hover:text-blue-800 dark:hover:text-blue-300"
              onClick={(e) => e.stopPropagation()}
            >
              {url}
            </a>
            {trailing}
          </React.Fragment>
        );
      })}
    </>
  );
}

export default memo(LinkText);
