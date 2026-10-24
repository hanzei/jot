import type { ReactNode } from 'react';

interface InfoRowProps {
  label: string;
  value: string;
  testId?: string;
}

/** One label/value line of a `<dl>`, as in About and Settings > Diagnostics. */
export const InfoRow = ({ label, value, testId }: InfoRowProps) => (
  <div className="flex justify-between text-sm min-w-0 gap-2">
    <dt className="shrink-0 text-gray-500 dark:text-gray-400">{label}</dt>
    <dd data-testid={testId} className="truncate text-gray-900 dark:text-white font-mono">{value}</dd>
  </div>
);

/** The small caps heading above a group of rows. */
export const InfoSubheading = ({ children }: { children: ReactNode }) => (
  <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-2">{children}</h3>
);
