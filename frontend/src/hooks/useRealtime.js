/**
 * React bindings for the realtime client.
 *
 * The bridge to the server-state cache (T1 → T2 handoff):
 *
 *   // Invalidate query keys whenever a topic fires (typical case):
 *   useRealtimeInvalidate('operations', [['/operations'], ['/admin/operations']]);
 *
 *   // Or run an arbitrary callback (legacy components with local fetch fns):
 *   useRealtimeTopic('game', (event) => refresh());
 *
 * Both hooks also fire on WS reconnect, so anything missed while the socket
 * was down is refetched — which is why subscribed surfaces don't need a
 * backup polling interval.
 */
import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import realtimeClient from '@/lib/realtime';

/** Subscribe to a topic for the lifetime of the component. The handler also
 *  runs (with a synthetic {event: 'reconnected'}) when the socket comes back
 *  after a gap. Pass a falsy topic to no-op (for conditional subscriptions). */
export function useRealtimeTopic(topic, handler) {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    if (!topic) return undefined;
    const onEvent = (event) => handlerRef.current(event);
    const offTopic = realtimeClient.subscribe(topic, onEvent);
    const offStatus = realtimeClient.onStatus((status) => {
      if (status === 'connected') onEvent({ topic, event: 'reconnected', data: {} });
    });
    return () => {
      offTopic();
      offStatus();
    };
  }, [topic]);
}

/** Invalidate TanStack Query keys whenever a topic fires (or reconnects). */
export function useRealtimeInvalidate(topic, queryKeys) {
  const queryClient = useQueryClient();
  const keysRef = useRef(queryKeys);
  keysRef.current = queryKeys;

  useRealtimeTopic(topic, () => {
    keysRef.current.forEach((queryKey) => {
      queryClient.invalidateQueries({ queryKey });
    });
  });
}

export default useRealtimeTopic;
