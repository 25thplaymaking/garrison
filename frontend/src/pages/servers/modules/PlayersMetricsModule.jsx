import React from 'react';
import { BarChart3, Users } from 'lucide-react';
import ModuleTabs from './ModuleTabs';
import PlayersModule from './PlayersModule';
import MetricsModule from './MetricsModule';

function PlayersMetricsModule({ initialTab = 'players' }) {
  return (
    <ModuleTabs
      title="Players & Metrics"
      description="Live population, player sessions, and server telemetry are grouped together for operational visibility."
      initialTab={initialTab}
      tabs={[
        {
          id: 'players',
          label: 'Players',
          icon: Users,
          component: PlayersModule,
          description: 'Active players, recent player sessions, identifiers, join times, and session duration.',
        },
        {
          id: 'metrics',
          label: 'Metrics',
          icon: BarChart3,
          component: MetricsModule,
          description: 'CPU, memory, FPS, AI, vehicle, network, uptime, and player telemetry over time.',
        },
      ]}
    />
  );
}

export default PlayersMetricsModule;
