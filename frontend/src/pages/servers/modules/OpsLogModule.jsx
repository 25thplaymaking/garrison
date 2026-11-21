import React from 'react';
import { StickyNote } from 'lucide-react';
import ModuleTabs from './ModuleTabs';
import NotesModule from './NotesModule';

// The browser-only Tasks tab was retired: its checklist lived in one person's
// localStorage, so assigned tasks never reached anyone. Notes are shared and
// carry status, priority, and follow-up; leftover local tasks are offered for
// conversion inside NotesModule. tools/todos still lands here.
function OpsLogModule() {
  return (
    <ModuleTabs
      title="Ops Log"
      description="Shared operating log for this server: changes, requests, moderation, tests, and handoffs."
      initialTab="notes"
      tabs={[
        {
          id: 'notes',
          label: 'Notes',
          icon: StickyNote,
          component: NotesModule,
          description: 'Shared operating log for this server: changes, requests, moderation, tests, and handoffs. Every operator sees these notes.',
        },
      ]}
    />
  );
}

export default OpsLogModule;
