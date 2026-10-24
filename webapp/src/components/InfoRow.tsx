interface InfoRowProps {
  label: string;
  value: string;
  testId?: string;
}

/** One label/value line of a `<dl>`, as in About and Settings > Diagnostics. */
const InfoRow = ({ label, value, testId }: InfoRowProps) => (
  <div className="flex justify-between text-sm min-w-0 gap-2">
    <dt className="shrink-0 text-gray-500 dark:text-gray-400">{label}</dt>
    <dd data-testid={testId} className="truncate text-gray-900 dark:text-white font-mono">{value}</dd>
  </div>
);

export default InfoRow;
