// Something that fetches a document by its address, as the fetcher a JWKS cache uses does.
export interface AddressFetcher<Rest extends unknown[], Result> {
  readonly fetch: (uri: string, ...rest: Rest) => Promise<Result>;
}

// A fetcher that, for `waitMs` after a fetch of an address failed, fails every other fetch of
// that address at once, without trying it. A cache that fetches on demand would otherwise fetch
// again for every request while the address can't be reached, each waiting out its timeouts and
// adding to the load there. A fetch inside the wait fails as one that was tried would, so
// whatever needs the document still fails closed. The addresses are the caller's own, a fixed
// few, so the record of failures never grows.
export function backingOff<Rest extends unknown[], Result>(
  fetcher: AddressFetcher<Rest, Result>,
  waitMs: number,
): AddressFetcher<Rest, Result> {
  const failedAt = new Map<string, number>();
  return {
    fetch: async (uri, ...rest) => {
      const failed = failedAt.get(uri);
      if (failed !== undefined && Date.now() - failed < waitMs) {
        throw new Error("The address failed to fetch moments ago");
      }
      try {
        return await fetcher.fetch(uri, ...rest);
      } catch (error) {
        failedAt.set(uri, Date.now());
        throw error;
      }
    },
  };
}
