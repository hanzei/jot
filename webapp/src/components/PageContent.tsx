import { type ReactNode } from 'react';

const PageContent = ({ children }: { children: ReactNode }) => (
  <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
    {children}
  </div>
);

export default PageContent;
