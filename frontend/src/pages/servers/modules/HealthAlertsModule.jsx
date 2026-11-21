import React from 'react';
import { Bell, ShieldAlert, ShieldCheck } from 'lucide-react';
import ModuleTabs from './ModuleTabs';
import WatchersModule from './WatchersModule';
import NotificationsModule from './NotificationsModule';
import IncidentsModule from './IncidentsModule';

// Incidents and notifications are both raised by the same runtime failures
// (crash, crash loop, failed start), so they triage in one place rather than
// two sidebar entries.
function EmbeddedIncidents() {
  return <IncidentsModule embedded />;
}

function HealthAlertsModule({ initialTab = 'incidents' }) {
  return (
    <ModuleTabs
      title="Health & Alerts"
      description="Incidents, active server notifications, and watcher coverage for live alert triage."
      initialTab={initialTab}
      tabs={[
        {
          id: 'incidents',
          label: 'Incidents',
          icon: ShieldAlert,
          component: EmbeddedIncidents,
          description: 'Crashes, crash loops, and failed starts. Repeats fold into one record, and the monitor resolves them once the server has run 5 minutes.',
        },
        {
          id: 'notifications',
          label: 'Notifications',
          icon: Bell,
          component: NotificationsModule,
          description: 'Runtime and provisioning notifications that need an acknowledgement or a clear. Down alerts can also go to a Discord webhook (Servers, Integrations).',
        },
        {
          id: 'watchers',
          label: 'Watchers',
          icon: ShieldCheck,
          component: WatchersModule,
          description: 'Manage watcher coverage, review active detections, and mark detections as safe, monitoring, or resolved.',
        },
      ]}
    />
  );
}

export default HealthAlertsModule;
