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
        const url = m?.[1] ?? part;
        const trailing = m?.[2] ?? '';
        return (
          <React.Fragment key={i}>
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
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
