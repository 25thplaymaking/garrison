import React from 'react';
import { GitBranch, Puzzle } from 'lucide-react';
import ModuleTabs from './ModuleTabs';
import ModsModule from './ModsModule';
import CompareServersModule from './CompareServersModule';

function ModsWorkspaceModule({ initialTab = 'mods' }) {
  return (
    <ModuleTabs
      title="Mods"
      description="Workshop load order, dependency handling, mirroring, and external loadout comparison now live together."
      initialTab={initialTab}
      tabs={[
        {
          id: 'mods',
          label: 'Loadout',
          icon: Puzzle,
          component: ModsModule,
          description: 'Manage the active workshop loadout, import/export config, mirror to other managed servers, and validate changes.',
        },
        {
          id: 'compare',
          label: 'Compare / Mirror',
          icon: GitBranch,
          component: CompareServersModule,
          description: 'Search the public Reforger server list, compare a server\'s mods with this one and mirror its mod list here.',
        },
      ]}
    />
  );
}

export default ModsWorkspaceModule;
