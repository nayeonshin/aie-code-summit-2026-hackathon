// Retry transient network/CDN failures during physics initialization.
export async function fetchAsset(url: string, label: string): Promise<Uint8Array> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(90000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      // Read inside the retry: connections can fail after headers arrive.
      return new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      if (attempt === 2) throw new Error(`${label} failed to download (${(error as Error).message}). Check your connection and reload.`);
      await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
    }
  }
  throw new Error(`${label} failed to download.`);
}
