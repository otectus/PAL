import type { ChatConnection } from './connections.ts';

/** Restrict ambient identity credentials to their intended audience, including on config reload. */
export function platformAuth(connection:ChatConnection) {
  const azure=connection.kind==='azure_openai' && connection.auth==='entra';
  const vertex=connection.kind==='google' && connection.variant==='vertex';
  if (!azure && !vertex) return undefined;
  const url=new URL(connection.compatible!.baseUrl);
  const government=/^[a-z0-9-]+\.openai\.azure\.us$/.test(url.hostname);
  const valid=azure ? government || /^[a-z0-9-]+\.(openai\.azure\.com|services\.ai\.azure\.com)$/.test(url.hostname)
    : /^([a-z0-9-]+-)?aiplatform\.googleapis\.com$/.test(url.hostname) && /^\/v1(?:beta1)?\/projects\/[a-z0-9-]+\/locations\/[a-z0-9-]+\/publishers\/google\/?$/.test(url.pathname);
  if (url.protocol!=='https:' || url.username || url.password || url.port || !valid) throw new Error('Platform identity requires the official resource URL for this account');
  return async () => {
    if (azure) {
      const {DefaultAzureCredential,AzureAuthorityHosts}=await import('@azure/identity');
      const credential=new DefaultAzureCredential({authorityHost:government?AzureAuthorityHosts.AzureGovernment:AzureAuthorityHosts.AzurePublicCloud});
      const token=await credential.getToken(government?'https://cognitiveservices.azure.us/.default':'https://cognitiveservices.azure.com/.default');
      return token.token;
    }
    const {GoogleAuth}=await import('google-auth-library');
    const token=await new GoogleAuth({scopes:['https://www.googleapis.com/auth/cloud-platform']}).getAccessToken();
    if (!token) throw new Error('Google Application Default Credentials did not supply an access token');
    return token;
  };
}
