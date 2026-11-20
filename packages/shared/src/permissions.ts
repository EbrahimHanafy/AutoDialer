import type { Role } from './types.js';

export const PERMISSIONS = [
  { key: 'agent.use', group: 'Agent console', label: 'Use agent console', description: 'Join campaigns, control calls, and change agent state.' },
  { key: 'campaigns.work', group: 'Agent console', label: 'Work assigned campaigns', description: 'Use campaigns assigned to the user from the agent console.' },
  { key: 'campaigns.view', group: 'Campaign Access', label: 'View campaigns', description: 'View the full campaign list and campaign headers.' },
  { key: 'campaigns.create', group: 'Campaign Access', label: 'Create campaigns', description: 'Create new campaigns.' },
  { key: 'campaigns.edit', group: 'Campaign Access', label: 'Edit campaigns', description: 'Edit campaign configuration and dialing settings.' },
  { key: 'campaigns.delete', group: 'Campaign Access', label: 'Delete campaigns', description: 'Permanently delete campaigns and their lists and leads.' },
  { key: 'campaigns.status.activate', group: 'Campaign Status', label: 'Activate campaigns', description: 'Change a campaign status to active.' },
  { key: 'campaigns.status.pause', group: 'Campaign Status', label: 'Pause campaigns', description: 'Change an active campaign status to paused.' },
  { key: 'campaigns.status.complete', group: 'Campaign Status', label: 'Complete campaigns', description: 'Change a campaign status to completed.' },
  { key: 'campaigns.status.draft', group: 'Campaign Status', label: 'Move campaigns to draft', description: 'Change a campaign status to draft through the campaign API.' },
  { key: 'campaigns.tabs.overview.view', group: 'Campaign Tabs', label: 'View campaign overview', description: 'Open the Overview tab and view campaign statistics and its configuration summary.' },
  { key: 'campaigns.tabs.lists.view', group: 'Campaign Tabs', label: 'View campaign lists tab', description: 'Open the Lists & Import tab; list data and actions require their separate permissions.' },
  { key: 'campaigns.tabs.leads.view', group: 'Campaign Tabs', label: 'View campaign leads tab', description: 'Open the Leads tab; lead data and actions require their separate permissions.' },
  { key: 'campaigns.tabs.agents.view', group: 'Campaign Tabs', label: 'View campaign agents tab', description: 'Open the Agents tab; assigned-agent data and actions require their separate permissions.' },
  { key: 'campaigns.tabs.settings.view', group: 'Campaign Tabs', label: 'View campaign settings', description: 'Open the Settings tab and view the campaign configuration.' },
  { key: 'campaigns.lists.view', group: 'Campaign Lists', label: 'View campaign lists', description: 'View lists and their lead counts inside a campaign.' },
  { key: 'campaigns.lists.create', group: 'Campaign Lists', label: 'Create campaign lists', description: 'Create new lead lists inside a campaign.' },
  { key: 'campaigns.lists.edit', group: 'Campaign Lists', label: 'Edit campaign lists', description: 'Rename campaign lists or change whether they are active.' },
  { key: 'campaigns.lists.delete', group: 'Campaign Lists', label: 'Delete campaign lists', description: 'Delete a campaign list and the leads it contains.' },
  { key: 'campaigns.lists.import', group: 'Campaign Lists', label: 'Import campaign list data', description: 'Preview and import lead data files into campaign lists.' },
  { key: 'campaigns.agents.view', group: 'Campaign Agents', label: 'View assigned agents', description: 'View available agents and the agents assigned to a campaign.' },
  { key: 'campaigns.agents.assign', group: 'Campaign Agents', label: 'Assign agents', description: 'Assign additional agents to a campaign.' },
  { key: 'campaigns.agents.unassign', group: 'Campaign Agents', label: 'Unassign agents', description: 'Remove assigned agents from a campaign.' },
  { key: 'campaigns.leads.view', group: 'Campaign Leads', label: 'View campaign leads', description: 'View lead records belonging to a campaign.' },
  { key: 'campaigns.leads.reset', group: 'Campaign Leads', label: 'Reset campaign leads', description: 'Reset matching campaign leads to the new state with zero attempts.' },
  { key: 'leads.work', group: 'Leads', label: 'Work leads', description: 'View, create, and edit lead contact information and notes.' },
  { key: 'leads.manage', group: 'Leads', label: 'Manage leads', description: 'Manage lead queue state and delete lead records.' },
  { key: 'leads.viewFullPhoneNumbers', group: 'Leads', label: 'View Full Customer Phone Numbers', description: 'Display complete customer phone numbers in data tables and exports.' },
  { key: 'dnc.work', group: 'Do-not-call', label: 'Use do-not-call list', description: 'View, check, and add numbers to the do-not-call list.' },
  { key: 'dnc.manage', group: 'Do-not-call', label: 'Import do-not-call numbers', description: 'Bulk import numbers into the do-not-call list.' },
  { key: 'dnc.delete', group: 'Do-not-call', label: 'Remove do-not-call numbers', description: 'Remove numbers from the do-not-call list.' },
  { key: 'dispositions.use', group: 'Dispositions', label: 'Use dispositions', description: 'View dispositions while handling calls.' },
  { key: 'dispositions.view', group: 'Dispositions', label: 'View disposition setup', description: 'Open the disposition administration page in read-only mode.' },
  { key: 'dispositions.manage', group: 'Dispositions', label: 'Manage dispositions', description: 'Create, edit, and delete custom dispositions.' },
  { key: 'scripts.use', group: 'Scripts', label: 'Use scripts', description: 'View and preview scripts while handling leads.' },
  { key: 'scripts.manage', group: 'Scripts', label: 'Manage scripts', description: 'Create, edit, and delete call scripts.' },
  { key: 'calls.own', group: 'Calls', label: 'View own calls', description: 'View own call history and upload or play own recordings.' },
  { key: 'calls.manage', group: 'Calls', label: 'Manage all calls', description: 'View all call history and recordings.' },
  { key: 'callbacks.own', group: 'Callbacks', label: 'Manage own callbacks', description: 'View and update callbacks assigned to the user.' },
  { key: 'callbacks.manage', group: 'Callbacks', label: 'Manage all callbacks', description: 'View, reassign, and update callbacks for all users.' },
  { key: 'dashboard.view', group: 'Live operations', label: 'View dashboard', description: 'View the live wallboard and force agent logout.' },
  { key: 'dashboard.view_gsm_dongles', group: 'Live operations', label: 'View GSM Dongles', description: 'View live GSM Dongle availability from Asterisk.' },
  { key: 'reports.view', group: 'Reports', label: 'View reports', description: 'View campaign, agent, disposition, and hourly reports.' },
  { key: 'users.view', group: 'Users', label: 'View users', description: 'View users for administration, reports, and campaign assignment.' },
  { key: 'users.manage', group: 'Users', label: 'Manage users', description: 'Create, edit, deactivate, and delete users, including their role assignment.' },
  { key: 'settings.view', group: 'Settings', label: 'View settings', description: 'View application and telephony settings.' },
  { key: 'settings.manage', group: 'Settings', label: 'Manage settings', description: 'Change application, telephony, compliance, and pause-code settings.' },
  { key: 'integrations.manage', group: 'Integrations', label: 'Manage integrations', description: 'Manage webhooks and API keys.' },
  { key: 'audit.view', group: 'System', label: 'View audit log', description: 'View the system audit log.' },
  { key: 'system.manage', group: 'System', label: 'Manage system and backups', description: 'View system information and create and list database backups.' },
  { key: 'calls.export', group: 'Data Export', label: 'Export call records', description: 'Export call history and call-report data to supported file formats.' },
  { key: 'leads.export', group: 'Data Export', label: 'Export lead records', description: 'Export lead contact, campaign, list, status, notes, and custom-field data.' },
  { key: 'backups.export', group: 'Data Export', label: 'Download database backups', description: 'Download database backup files containing application data.' },
] as const;

export type Permission = (typeof PERMISSIONS)[number]['key'];
export const PERMISSION_KEYS = PERMISSIONS.map((p) => p.key) as Permission[];
export const CAMPAIGN_TAB_PERMISSIONS = {
  overview: 'campaigns.tabs.overview.view',
  lists: 'campaigns.tabs.lists.view',
  leads: 'campaigns.tabs.leads.view',
  agents: 'campaigns.tabs.agents.view',
  settings: 'campaigns.tabs.settings.view',
} as const satisfies Record<string, Permission>;

const IMPLIES: Partial<Record<Permission, readonly Permission[]>> = {
  'leads.manage': ['leads.work'],
  'dnc.manage': ['dnc.work'],
  'dnc.delete': ['dnc.manage', 'dnc.work'],
  'dispositions.view': ['dispositions.use'],
  'dispositions.manage': ['dispositions.view', 'dispositions.use'],
  'scripts.manage': ['scripts.use'],
  'calls.manage': ['calls.own'],
  'callbacks.manage': ['callbacks.own'],
  'users.manage': ['users.view'],
  'settings.manage': ['settings.view'],
};

export function grantsPermission(granted: readonly Permission[], permission: Permission): boolean {
  return granted.includes(permission) || granted.some((key) => IMPLIES[key]?.includes(permission));
}

const agent: Permission[] = [
  'agent.use', 'campaigns.work', 'leads.work', 'dnc.work', 'dispositions.use', 'scripts.use', 'calls.own', 'callbacks.own',
];
const supervisor: Permission[] = [
  ...agent,
  'campaigns.view', 'campaigns.create', 'campaigns.edit',
  'campaigns.status.activate', 'campaigns.status.pause', 'campaigns.status.complete', 'campaigns.status.draft',
  ...Object.values(CAMPAIGN_TAB_PERMISSIONS),
  'campaigns.lists.view', 'campaigns.lists.create', 'campaigns.lists.edit', 'campaigns.lists.delete', 'campaigns.lists.import',
  'campaigns.agents.view', 'campaigns.agents.assign', 'campaigns.agents.unassign',
  'campaigns.leads.view', 'campaigns.leads.reset',
  'leads.manage', 'dnc.manage', 'dispositions.view', 'scripts.manage', 'calls.manage', 'callbacks.manage',
  'dashboard.view', 'reports.view', 'users.view', 'settings.view', 'audit.view', 'calls.export', 'leads.export',
];

export const SYSTEM_ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  agent,
  supervisor,
  admin: [
    ...supervisor,
    'leads.viewFullPhoneNumbers', 'dashboard.view_gsm_dongles', 'campaigns.delete', 'dnc.delete', 'dispositions.manage', 'users.manage', 'settings.manage', 'integrations.manage', 'system.manage', 'backups.export',
  ],
};

