import {
  maskPhone,
  type AgentSnapshot,
  type AuditEntry,
  type CallLog,
  type Callback,
  type DncEntry,
  type Lead,
  type Paginated,
  type WallboardSnapshot,
} from '@opendialer/shared';

export function tableLead(lead: Lead, showFull: boolean): Lead {
  if (showFull) return lead;
  return { ...lead, phone: maskPhone(lead.phone), rawPhone: maskPhone(lead.rawPhone) };
}

export function tableCall(call: CallLog, showFull: boolean): CallLog {
  return showFull ? call : { ...call, phone: maskPhone(call.phone) };
}

export function tableCallback(callback: Callback, showFull: boolean): Callback {
  if (showFull || !callback.lead) return callback;
  return { ...callback, lead: tableLead(callback.lead, false) };
}

export function tableDncEntry(entry: DncEntry, showFull: boolean): DncEntry {
  return showFull ? entry : { ...entry, phone: maskPhone(entry.phone) };
}

export function tableLeadPage(page: Paginated<Lead>, showFull: boolean): Paginated<Lead> {
  return showFull ? page : { ...page, items: page.items.map((lead) => tableLead(lead, false)) };
}

export function tableCallPage(page: Paginated<CallLog>, showFull: boolean): Paginated<CallLog> {
  return showFull ? page : { ...page, items: page.items.map((call) => tableCall(call, false)) };
}

export function tableDncPage(page: Paginated<DncEntry>, showFull: boolean): Paginated<DncEntry> {
  return showFull ? page : { ...page, items: page.items.map((entry) => tableDncEntry(entry, false)) };
}

export function tableAgent(agent: AgentSnapshot, showFull: boolean): AgentSnapshot {
  return showFull || !agent.phone ? agent : { ...agent, phone: maskPhone(agent.phone) };
}

export function tableWallboard(snapshot: WallboardSnapshot, showFull: boolean): WallboardSnapshot {
  return showFull ? snapshot : { ...snapshot, agents: snapshot.agents.map((agent) => tableAgent(agent, false)) };
}

function maskKnownPhoneFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(maskKnownPhoneFields);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    /^(phone|rawPhone|raw_phone)$/i.test(key) && typeof item === 'string' ? maskPhone(item) : maskKnownPhoneFields(item),
  ]));
}

export function tableAuditPage(page: Paginated<AuditEntry>, showFull: boolean): Paginated<AuditEntry> {
  if (showFull) return page;
  return {
    ...page,
    items: page.items.map((entry) => {
      try {
        return { ...entry, details: JSON.stringify(maskKnownPhoneFields(JSON.parse(entry.details))) };
      } catch {
        return entry;
      }
    }),
  };
}
