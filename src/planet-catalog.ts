export interface OrraahPlanet {patp: string; status: string}
export interface PlanetCatalog {planets: OrraahPlanet[]; observedAt: string}
const endpoint = 'https://updates.orraah.com/api/planets';
const byteLimit = 128 * 1024;
class CatalogError extends Error {}
function invalid(): never {throw new CatalogError('The planet catalog response is invalid.');}
function catalog(value: unknown): OrraahPlanet[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  const root = value as Record<string, unknown>;
  if (Object.keys(root).length !== 1 || !Object.hasOwn(root, 'planets') || !Array.isArray(root.planets) || root.planets.length > 256) return invalid();
  const seen = new Set<string>();
  return root.planets.map((value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
    const row = value as Record<string, unknown>;
    if (Object.keys(row).length !== 2 || !Object.hasOwn(row, 'patp') || !Object.hasOwn(row, 'status') ||
      typeof row.patp !== 'string' || !/^~[a-z]{6}-[a-z]{6}(?![\s\S])/.test(row.patp) || seen.has(row.patp) ||
      typeof row.status !== 'string' || !/^[a-z][a-z0-9_-]{0,31}(?![\s\S])/.test(row.status)) return invalid();
    seen.add(row.patp);
    return {patp: row.patp, status: row.status};
  });
}
/** Public metadata only. Names are syntactically checked, not ownership or chain proofs. */
export async function fetchPlanetCatalog(fetcher: typeof fetch = fetch, signal?: AbortSignal): Promise<PlanetCatalog> {
  const controller = new AbortController(), deadline = Date.now() + 8000;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel = () => undefined as void;
  const timeout = new Promise<never>((_, reject) => {
    cancel = () => {reject(new CatalogError('The planet catalog request was canceled.')); controller.abort();};
    signal?.addEventListener('abort', cancel, {once: true});
    if (signal?.aborted) cancel();
    timer = setTimeout(() => {reject(new CatalogError('The planet catalog request timed out.')); controller.abort();}, 8000);
  });
  const read = async (): Promise<PlanetCatalog> => {
    if (controller.signal.aborted) throw new CatalogError('The planet catalog request was canceled.');
    const response = await fetcher(endpoint, {method: 'GET', headers: {Accept: 'application/json'}, credentials: 'omit', redirect: 'error', signal: controller.signal});
    if (controller.signal.aborted || Date.now() >= deadline) throw new CatalogError('The planet catalog request timed out.');
    if (response.status !== 200 || response.redirected) throw new CatalogError('The planet catalog is unavailable.');
    if (!/^application\/json(?:\s*;.*)?$/i.test(response.headers.get('content-type') ?? '') || !response.body) return invalid();
    reader = response.body.getReader();
    const chunks: Uint8Array[] = []; let length = 0;
    while (true) {
      const chunk = await reader.read();
      if (controller.signal.aborted || Date.now() >= deadline) throw new CatalogError('The planet catalog request timed out.');
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > byteLimit) throw new CatalogError('The planet catalog response is too large.');
      if (chunk.value.byteLength) chunks.push(chunk.value);
    }
    const bytes = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) {bytes.set(chunk, offset); offset += chunk.byteLength;}
    const planets = catalog(JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes)));
    if (Date.now() >= deadline) throw new CatalogError('The planet catalog request timed out.');
    return {planets, observedAt: new Date().toISOString()};
  };
  try {return await Promise.race([read(), timeout]);}
  catch (error) {throw error instanceof CatalogError ? error : new CatalogError('The planet catalog could not be read.');}
  finally {
    clearTimeout(timer); signal?.removeEventListener('abort', cancel); controller.abort();
    if (reader) void reader.cancel().catch(() => undefined);
  }
}
