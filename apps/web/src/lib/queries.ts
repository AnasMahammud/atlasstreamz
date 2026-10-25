import { QueryClient, keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, enc, qs, type Card, type Category, type ChannelDetail, type HeroItem, type MovieDetail, type Profile, type Programme, type Row, type SeriesDetail, type Status } from './api.ts';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,
      gcTime: 30 * 60_000,
      retry: (count, err: any) => count < 2 && (err?.status ?? 0) >= 500,
      refetchOnWindowFocus: false,
      networkMode: 'offlineFirst',
    },
  },
});

export function useStatus() {
  return useQuery({
    queryKey: ['status'],
    queryFn: ({ signal }) => api.get<Status>('/api/status', signal),
    staleTime: 5_000,
    // Poll while a sync runs so progress and the refresh indicator stay live.
    refetchInterval: (q) => (q.state.data?.sync?.running ? 2_000 : 60_000),
  });
}

export function useProfiles(enabled = true) {
  return useQuery({ queryKey: ['profiles'], queryFn: ({ signal }) => api.get<{ profiles: Profile[]; avatars: string[] }>('/api/profiles', signal), enabled });
}

export function useHome() {
  return useQuery({ queryKey: ['home'], queryFn: ({ signal }) => api.get<{ hero: HeroItem[]; rows: Row[] }>('/api/home', signal), staleTime: 2 * 60_000 });
}

export function useCategories(kind: 'live' | 'movie' | 'series') {
  return useQuery({ queryKey: ['categories', kind], queryFn: ({ signal }) => api.get<Category[]>(`/api/categories?kind=${kind}`, signal), staleTime: 10 * 60_000 });
}

export interface BrowseParams {
  category?: string;
  genre?: string;
  sort?: string;
  yearFrom?: number;
  yearTo?: number;
}

const PAGE = 60;

export function useBrowse(kind: 'movies' | 'series' | 'channels', params: BrowseParams) {
  return useInfiniteQuery({
    queryKey: ['browse', kind, params],
    initialPageParam: 0,
    queryFn: ({ pageParam, signal }) => api.get<{ items: Card[]; total: number }>(`/api/${kind}${qs({ ...params, offset: pageParam, limit: PAGE })}`, signal),
    getNextPageParam: (last, pages) => {
      const loaded = pages.reduce((n, p) => n + p.items.length, 0);
      return loaded < last.total ? loaded : undefined;
    },
    placeholderData: keepPreviousData,
  });
}

export function useMovie(id: string) {
  return useQuery({ queryKey: ['movie', id], queryFn: ({ signal }) => api.get<MovieDetail>(`/api/movies/${enc(id)}`, signal) });
}

export function useSeries(id: string) {
  return useQuery({ queryKey: ['series', id], queryFn: ({ signal }) => api.get<SeriesDetail>(`/api/series/${enc(id)}`, signal) });
}

export function useChannel(id: string | undefined) {
  return useQuery({ queryKey: ['channel', id], queryFn: ({ signal }) => api.get<ChannelDetail>(`/api/channels/${enc(id!)}`, signal), enabled: !!id, staleTime: 30_000 });
}

export function useGuide(params: { category?: string; from: number; to: number }) {
  return useInfiniteQuery({
    queryKey: ['guide', params],
    initialPageParam: 0,
    queryFn: ({ pageParam, signal }) =>
      api.get<{ items: Card[]; total: number; programmes: Record<string, Programme[]>; from: number; to: number }>(`/api/guide${qs({ ...params, offset: pageParam, limit: 40 })}`, signal),
    getNextPageParam: (last, pages) => {
      const loaded = pages.reduce((n, p) => n + p.items.length, 0);
      return loaded < last.total ? loaded : undefined;
    },
    staleTime: 60_000,
  });
}

export function useMyList() {
  return useQuery({ queryKey: ['my-list'], queryFn: ({ signal }) => api.get<{ items: Card[] }>('/api/me/list', signal) });
}

/** Add/remove from My List with an optimistic flip. */
export function useListToggle(id: string, kindKey: 'movie' | 'series' | 'channel') {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (add: boolean) => (add ? api.put(`/api/me/list/${enc(id)}`) : api.del(`/api/me/list/${enc(id)}`)),
    onMutate: (add) => {
      qc.setQueryData([kindKey, id], (d: any) => (d ? { ...d, inList: add } : d));
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['my-list'] });
      void qc.invalidateQueries({ queryKey: ['home'] });
      void qc.invalidateQueries({ queryKey: [kindKey, id] });
    },
  });
}
