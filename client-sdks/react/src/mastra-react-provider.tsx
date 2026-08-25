import type { MastraClientProviderProps } from './mastra-client-context';
import { MastraClientProvider } from './mastra-client-context';
type MastraReactProviderProps = MastraClientProviderProps;

export const MastraReactProvider = ({
  children,
  baseUrl,
  headers,
  apiPrefix,
  credentials,
  customFetch,
  retries,
}: MastraReactProviderProps) => {
  return (
    <MastraClientProvider
      baseUrl={baseUrl}
      headers={headers}
      apiPrefix={apiPrefix}
      credentials={credentials}
      customFetch={customFetch}
      retries={retries}
    >
      {children}
    </MastraClientProvider>
  );
};
