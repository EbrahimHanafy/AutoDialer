import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import GsmDongles from './GsmDongles';

vi.mock('../../hooks/useGsmDongles', () => ({
  useGsmDongles: () => ({
    mode: 'socket',
    snapshot: {
      status: 'available',
      total: 2,
      ready: 1,
      refreshedAt: '2026-11-19T10:00:00.000Z',
      devices: [
        {
          name: 'dongle0', state: 'Free', imeiLast4: '2345', group: '0', rssi: '21',
          mode: '5', submode: '7', provider: 'Vodafone', model: 'E173', firmware: '11.126.85.00',
        },
        {
          name: 'dongle1', state: 'Not connected', imeiLast4: null, group: '0', rssi: '0',
          mode: null, submode: null, provider: null, model: null, firmware: null,
        },
      ],
    },
  }),
}));

afterEach(cleanup);

describe('GSM Dongles details page', () => {
  it('shows live device states and only the supplied IMEI ending', () => {
    const { container } = render(<MemoryRouter><GsmDongles /></MemoryRouter>);
    expect(screen.getByText('dongle0')).toBeTruthy();
    expect(screen.getByText('dongle1')).toBeTruthy();
    expect(screen.getByText('•••• 2345')).toBeTruthy();
    expect(container.textContent).not.toContain('123456789012345');
    expect(screen.getAllByTestId('dongle-tile')).toHaveLength(2);
  });
});
