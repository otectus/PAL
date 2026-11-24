/** Bound bytes on the wire before decoding JSON, base64 or media. Never echo an upstream error body. */
export async function responseBytes(response: Response, limit: number): Promise<Buffer> {
  if (!response.ok || !response.body || Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel().catch(() => {});
    throw new Error(response.ok ? 'Missing or oversized provider response' : 'Provider returned HTTP ' + response.status);
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > limit) throw new Error('Provider response exceeded its size limit');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks,size);
}
export async function responseJson(response: Response, limit = 2 * 1024 * 1024) {
  const bytes = await responseBytes(response,limit);
  try { return JSON.parse(bytes.toString('utf8')); }
  catch { throw new Error('The provider returned invalid JSON'); }
}
