import React from 'react';
import { Monitor, Terminal } from 'lucide-react';
import ModuleTabs from './ModuleTabs';
import ConsoleModule from './ConsoleModule';
import RconModule from './RconModule';

function LiveControlModule({ initialTab = 'console' }) {
  return (
    <ModuleTabs
      title="Live Control"
      description="Console logs and BattlEye RCON commands share one live-control surface for runtime response."
      initialTab={initialTab}
      tabs={[
        {
          id: 'console',
          label: 'Console',
          icon: Terminal,
          component: ConsoleModule,
          description: 'Merged runtime logs, stream status, filtering, copy, and download controls.',
        },
        {
          id: 'rcon',
          label: 'RCON',
          icon: Monitor,
          component: RconModule,
          description: 'BattlEye RCON command execution, quick commands, saved snippets, and command history.',
        },
      ]}
    />
  );
}

export default LiveControlModule;
