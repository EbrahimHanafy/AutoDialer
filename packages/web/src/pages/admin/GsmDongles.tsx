import { Link } from 'react-router-dom';
import type { GsmDongleDevice } from '@opendialer/shared';
import { useGsmDongles } from '../../hooks/useGsmDongles';

type VisualState = 'ready' | 'busy' | 'initializing' | 'offline';

function visualState(state: string): VisualState {
  const value = state.trim().toLowerCase();
  if (/^(free|ready|connected)$/.test(value)) return 'ready';
  if (/(dial|call|active|incoming|outgoing|busy|reserved|ring)/.test(value)) return 'busy';
  if (/(init|start|register|search)/.test(value)) return 'initializing';
  return 'offline';
}

function detail(label: string, value: string | null) {
  if (!value) return null;
  return <div><dt>{label}</dt><dd>{value}</dd></div>;
}

function DongleTile({ device }: { device: GsmDongleDevice }) {
  const visual = visualState(device.state);
  const badge = visual === 'ready' ? 'green' : visual === 'busy' ? 'blue' : visual === 'initializing' ? 'amber' : 'red';
  return (
    <article className={`dongle-tile dongle-${visual}`} data-testid="dongle-tile" data-state={device.state}>
      <div className="row between">
        <strong className="dongle-name">{device.name}</strong>
        <span className={`badge ${badge}`}>{device.state}</span>
      </div>
      <dl className="dongle-details">
        {detail('IMEI ending', device.imeiLast4 ? `•••• ${device.imeiLast4}` : null)}
        {detail('Group', device.group)}
        {detail('Signal', device.rssi)}
        {detail('Provider', device.provider)}
        {detail('Model', device.model)}
        {detail('Mode', [device.mode, device.submode].filter(Boolean).join(' / ') || null)}
        {detail('Firmware', device.firmware)}
      </dl>
    </article>
  );
}

export default function GsmDongles() {
  const { snapshot, mode } = useGsmDongles();
  const status = snapshot?.status ?? 'loading';
  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>GSM Dongles</h1>
          <p className="muted">Live device states from Asterisk · {mode === 'socket' ? 'Live' : 'Polling every 5 s'}</p>
        </div>
        <Link to="/admin/dashboard" className="btn">← Dashboard</Link>
      </div>

      <div className="grid cols-3 dongle-summary">
        <div className="stat"><div className="label">Detected</div><div className="value">{snapshot?.total ?? '—'}</div></div>
        <div className="stat"><div className="label">Ready</div><div className="value">{snapshot?.ready ?? '—'}</div></div>
        <div className="stat">
          <div className="label">Last refresh</div>
          <div className="value small-value">{snapshot?.refreshedAt ? new Date(snapshot.refreshedAt).toLocaleTimeString() : '—'}</div>
        </div>
      </div>

      {status === 'loading' && <div className="alert info row"><span className="spinner" /> Loading dongles from Asterisk…</div>}
      {status === 'unavailable' && <div className="alert error">Asterisk monitoring is unavailable. No device count has been assumed.</div>}
      {status === 'stale' && <div className="alert warning">Showing the last successful device snapshot. Asterisk is currently unreachable.</div>}
      {(status === 'available' || status === 'stale') && snapshot?.devices.length === 0 && <p className="muted">No GSM Dongles were detected.</p>}

      <div className="grid auto dongle-grid">
        {snapshot?.devices.map((device) => <DongleTile key={device.name} device={device} />)}
      </div>
    </div>
  );
}
