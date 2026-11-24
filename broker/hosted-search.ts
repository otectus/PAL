import type { Settings } from './types.ts';
import type { ProviderCredentials } from './credentials.ts';
import { responseJson } from './provider-http.ts';

/** Raw ranked links for PAL's source pipeline. The key stays with the fixed service origin. */
export async function hostedSearch(provider:'perplexity'|'google_custom', query:string, settings:Settings['webSearch'], credentials:ProviderCredentials, signal:AbortSignal, send=fetch) {
  const key=credentials.key(provider==='perplexity'?provider:'google_search');
  if (!key) throw new Error('Add a search service key in Connections');
  let data:any;
  if (provider==='perplexity') {
    data=await responseJson(await send('https://api.perplexity.ai/search',{method:'POST',signal,redirect:'error',headers:{'Content-Type':'application/json',Authorization:'Bearer '+key},body:JSON.stringify({query,max_results:6})}));
    if (!Array.isArray(data.results)) throw new Error('Perplexity returned an invalid search result list');
    return data.results.map((r:any)=>({title:r.title,url:r.url,content:r.snippet}));
  }
  if (!settings.googleEngineId) throw new Error('Configure an existing Google Custom Search engine ID');
  const url=new URL('https://customsearch.googleapis.com/customsearch/v1');
  url.search=new URLSearchParams({cx:settings.googleEngineId,q:query,num:'6'}).toString();
  data=await responseJson(await send(url,{signal,redirect:'error',headers:{'x-goog-api-key':key}}));
  return (data.items || []).map((r:any)=>({title:r.title,url:r.link,content:r.snippet}));
}
