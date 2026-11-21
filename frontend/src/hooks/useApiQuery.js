/**
 * Convenience wrappers over TanStack Query + apiClient for the common cases.
 *
 *   const { data, isLoading, error } = useApiQuery('/operations');
 *   const { data } = useApiQuery('/servers', { params: { limit: 50 }, refetchInterval: 15_000 });
 *   const save = useApiMutation((body) => apiClient.post('/operations', body), {
 *     invalidates: [['/operations']],
 *   });
 *
 * Anything more involved (dependent queries, optimistic updates, pagination)
 * should use `useQuery` / `useMutation` from '@tanstack/react-query' directly —
 * these wrappers deliberately stay thin.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import apiClient from '@/lib/apiClient';

export function useApiQuery(path, { params, ...options } = {}) {
  return useQuery({
    queryKey: params ? [path, params] : [path],
    queryFn: async ({ signal }) => {
      const { data } = await apiClient.get(path, { params, signal });
      return data;
    },
    ...options,
  });
}

export function useApiMutation(mutationFn, { invalidates = [], ...options } = {}) {
  const client = useQueryClient();
  return useMutation({
    mutationFn,
    ...options,
    onSuccess: async (...args) => {
      await Promise.all(
        invalidates.map((queryKey) => client.invalidateQueries({ queryKey })),
      );
      return options.onSuccess?.(...args);
    },
  });
}

export default useApiQuery;
