# Predictive dialing

Predictive mode lets the **server** dial ahead of the agents through Asterisk
(AMI), instead of each agent's softphone dialing one call at a time. An
answered call is parked in a `BridgeWait` hold where the customer hears
**ringback** (not silence), and is bridged to the next free agent within
seconds. The agent's softphone receives the bridged call and auto-answers;
the usual call screen (lead, campaign, timer, dispositions) opens from the
server's assignment event, exactly like progressive mode.

Validated live on VitalPBX 4 / Asterisk 20.21 with chan_dongle GSM dongles
before it was built: originate → answer → BridgeWait ringback hold → bridge
to a WebRTC agent extension → two-way audio.

## How it works

1. For each active `predictive` campaign, the engine keeps a pipeline of
   ringing calls: `ceil((readyAgents + agentsFreeingSoon) × pacingRatio)`,
   capped by the answered-call buffer. *Agents freeing soon* are agents in
   wrap-up, plus talking agents whose talk time passed
   `avgTalk − launchAheadSec` — so dials start **before** the agent is free
   and the answer lands as they become ready.
2. Leads are claimed by the dialer itself (`locked_by = -1` sentinel), and a
   call row is created with `user_id = NULL`. The compliance gate (DNC,
   calling hours, attempts, consent) runs inside the claim, exactly as for
   agent dials.
3. The AMI adapter originates `<DIALER_CHANNEL_PREFIX><phone>` into
   `BridgeWait(predictive,participant,e(r)S(<abandonTimeoutSec>))` with a
   timeout of the campaign's `ringTimeoutSec`. `OriginateResponse` is the
   answer signal.
4. On answer, the longest-ready agent is bridged (`Originate PJSIP/<agent
   ext>` → `Bridge`). The call row gets its agent, the lead lock moves to the
   agent, and the agent receives `lead:assigned` (with `predictive: true`
   and the call id) + `call:started`.
5. No-answer / busy / failed attempts are auto-dispositioned (NO_ANSWER /
   BUSY) with attempts and retry timing updated, and never touch an agent.
6. An answered call that waits longer than `abandonTimeoutSec` is hung up,
   marked `abandoned`, and its lead is re-queued via the NO_ANSWER
   disposition. A rolling abandon rate (last 50 answered calls) above
   `maxAbandonRate` **suspends predictive dialing for 5 minutes** and agents
   fall back to progressive assignment until it recovers.

## Defaults (calibrated on real traffic)

| Setting | Default | Why |
|---|---|---|
| Ring timeout | 35 s | GSM answer supervision is slow: mean ring-to-answer was 19 s (p90 32 s). 25 s would have lost ~21% of answers, 35 s loses ~5%. |
| Launch ahead | 19 s | The measured mean ring time of answered calls. |
| Buffer | 1 answered call | One answered call may wait on top of the ready agents. |
| Abandon timeout | 25 s | Max wait in the BridgeWait hold (`S(25)`). |
| Pacing ratio | 1.5 | Lines ringing per ready/freeing agent. |
| Abandon cap | 3% | Rolling, with progressive fallback (see above). |

Dongle math: every GSM dongle carries **one** call. Ringing attempts occupy
a line ~26 s on average (measured), so 3 agents need ~5–6 ringing lines +
3 talking ≈ 9 dongles for full throughput; 7 dongles still reach roughly
70% of the talk-time ceiling (vs ~52% in progressive).

## Enabling it

Predictive dialing is **off unless configured**. Set:

| Variable | Default | What it does |
|---|---|---|
| `PREDICTIVE_ENABLED` | `false` | Master switch. Predictive campaigns only dial when this is `true` **and** `AMI_USER`/`AMI_SECRET` are set. |
| `AMI_HOST` | `ASTERISK_AMI_HOST` or `127.0.0.1` | Asterisk Manager Interface host. |
| `AMI_PORT` | `ASTERISK_AMI_PORT` or `5038` | Asterisk Manager Interface TCP port. |
| `AMI_USER` | *(empty)* | Dedicated AMI username for the dialer (separate from the monitoring account). |
| `AMI_SECRET` | *(empty)* | That account's secret. Keep it in the service environment/secrets store. |
| `DIALER_CHANNEL_PREFIX` | `Dongle/r0/` | Dial-string prefix; the phone number is appended. `Dongle/r0/` = chan_dongle round-robin over group 0. Use `Dongle/dongle0/` to pin one device. |

Create a dedicated AMI account (VitalPBX: a custom `manager` include /
`manager.conf`). It needs to originate and hang up calls and read call
events — nothing else:

```ini
[opendialer-dialer]
secret = use-a-long-random-secret
deny = 0.0.0.0/0.0.0.0
permit = 127.0.0.1/255.255.255.255
read = call
write = call,originate
```

Restrict `permit` to the OpenDialer server address and **never expose TCP
5038 to the public internet**. Each agent also needs their Asterisk
extension in their OpenDialer user profile (`sip_username`, e.g. `111`) —
the bridge leg is originated to `PJSIP/<sip_username>`.

Then set the campaign's dial mode to **Predictive** and tune the pacing
fields on the campaign form.

## Limitations of this MVP

- **No answering-machine detection** (measured voicemail share was 0.4% of
  dispositions and short talks 5.2% of answers, so agents disposition the
  rare voicemail in a few seconds). `amd_enabled` exists in the schema but
  is not acted on.
- **Recordings** are browser-side as usual, so they start at the bridge —
  the ringing phase is not recorded (Asterisk MixMonitor is a future step).
- Pacing is anticipatory but not adaptive: the ratio is fixed per campaign;
  the only adaptation is the abandon guard with progressive fallback.
- If predictive telephony is not configured, predictive campaigns simply do
  not dial (a warning is logged once per campaign); agents are not handed
  leads for them.
