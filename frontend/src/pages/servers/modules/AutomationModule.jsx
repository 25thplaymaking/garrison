import React from 'react';
import { CalendarClock } from 'lucide-react';
import ModuleTabs from './ModuleTabs';
import SchedulesModule from './SchedulesModule';

function AutomationModule() {
  return (
    <ModuleTabs
      title="Automation"
      description="Scheduled jobs and recurring server actions are grouped under automation."
      initialTab="schedules"
      tabs={[
        {
          id: 'schedules',
          label: 'Schedules',
          icon: CalendarClock,
          component: SchedulesModule,
          description: 'Create and manage scheduled server actions, maintenance windows, and recurring automation.',
        },
      ]}
    />
  );
}

export default AutomationModule;
