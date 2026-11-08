// Retry transient network/CDN failures during physics initialization.
export function withAbort<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending;
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) abort();
  });
}

export async function fetchAsset(url: string, label: string, signal?: AbortSignal): Promise<Uint8Array> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      signal?.throwIfAborted();
      const timeout = AbortSignal.timeout(90000);
      const response = await fetch(url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      // Read inside the retry: connections can fail after headers arrive.
      return new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      signal?.throwIfAborted();
      if (attempt === 2) throw new Error(`${label} failed to download (${(error as Error).message}). Check your connection and reload.`);
      await withAbort(new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1))), signal);
    }
  }
  throw new Error(`${label} failed to download.`);
}
