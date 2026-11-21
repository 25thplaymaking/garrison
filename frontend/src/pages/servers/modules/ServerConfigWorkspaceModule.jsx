import React from 'react';
import { FileJson, History, Settings, ShieldAlert } from 'lucide-react';
import ModuleTabs from './ModuleTabs';
import ServerSettingsModule from './ServerSettingsModule';
import SatConfigModule from './SatConfigModule';
import AddonConfigsModule from './AddonConfigsModule';
import ConfigRevisionHistory from './history/ConfigRevisionHistory';

function ServerConfigWorkspaceModule({ initialTab = 'server' }) {
  return (
    <ModuleTabs
      title="Server Config"
      description="Primary server configuration and Server Admin Tools settings are grouped here so runtime setup has one home."
      initialTab={initialTab}
      tabs={[
        {
          id: 'server',
          label: 'Server',
          icon: Settings,
          component: ServerSettingsModule,
          description: 'Edit Arma server config, runtime values, RCON, scenarios, and deployable server settings.',
        },
        {
          id: 'admin-tools',
          label: 'Admin Tools',
          icon: ShieldAlert,
          component: SatConfigModule,
          description: 'Configure Server Admin Tools data, admin lists, bans, repeated messages, and event integration fields.',
        },
        {
          // Separate from base config on purpose: addon settings live in each
          // addon's own JSON under the profile tree and have nothing to do with
          // the Reforger server config options above.
          id: 'addon-configs',
          label: 'Addon Configs',
          icon: FileJson,
          component: AddonConfigsModule,
          description: 'Edit each addon\'s own JSON settings — drive-by permissions, FOV limits, stamina, and the rest — without hunting through the file manager.',
        },
        {
          id: 'history',
          label: 'History',
          icon: History,
          component: ConfigRevisionHistory,
          description: 'Every recorded config change, what fields it touched, and a revert.',
        },
      ]}
    />
  );
}

export default ServerConfigWorkspaceModule;
