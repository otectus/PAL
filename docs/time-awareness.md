# Time awareness

PAL tells the assistant the current date, time and time zone, and can tell it how long ago earlier messages in the conversation were. The time is the desktop’s own clock. PAL does not check it against a time server, and this feature opens no network connection, starts no process and does not use location.

## What a model is told

Each request PAL composes carries a small block (`pal_time_context`) with one clock reading: the UTC time, the local date and time with its offset, the time zone and where that zone came from, and the weekday. With conversation timing on, it also carries when the message was received, its calendar date, and the time since the person’s previous message. The block is never saved as anyone’s words, never given to memory, and is dropped with the request.

Two times travel with a message. Its received time and date decide what “tomorrow” means in it, however long it waited in a queue. The newest reading answers “what time is it now”.

| Conversation | When the reading is taken |
| --- | --- |
| Ollama and hosted or compatible API models | Before every request PAL sends, including after each tool and before a retry |
| Claude models whose reasoning belongs to the exact text before it, and Claude with prompt caching | With the first request of each message. The clock tool gives later readings |
| Codex | With each message, as turn context; a new time never restarts the Codex process |
| Claude Code | With each message, in the private prompt file |
| AntiGravity | With each message. No clock tool is offered there |
| Realtime voice | When the voice session begins. The clock tool gives later readings |
| Terminal sessions PAL only links to | Never; PAL does not compose their requests |

Codex and Claude Code run their own tool rounds inside a message. PAL cannot renew the reading inside those rounds; the `time_now` tool can.

The **Context** view of a conversation shows the zone the next message is told, and for the last request its reading, zone and source, how it was sent, whether it is renewed, and whether elapsed time was included.

## Clock tools

`time_now` reads the clock, optionally in another time zone. `time_elapsed` measures from an event of the same conversation: its creation, the previous message, the last finished reply, the start of the current turn, or one message. Both are read-only, need no approval and no desktop, web or memory permission. They are offered to Ollama, API and realtime conversations (not to models with a window of 8,192 tokens or less, where each request already carries a fresh reading) and, over PAL’s tool bridge, to Codex and Claude Code. Pausing AI actions withdraws them.

Elapsed time includes every pause. It is not a measure of work. An unknown time is reported as unknown, never as zero. If the clock was set back since an event, the interval is reported as inconsistent; after a forward jump or a sleep, the answer says so.

## Which time zone

In order: the conversation’s own zone, a fixed zone from Settings, the zone of the phone that sent the message, this computer’s zone, then UTC. A scheduled recipe keeps the zone its schedule was reviewed in. A zone PAL does not recognise in a phone’s message is ignored and the fallback is named. Changing a zone never moves a timer or a schedule.

Set a conversation’s zone from **More › Clock and time zone…** beside Send, or on the phone from the conversation menu.

## Settings

**Settings › Application › Time awareness** on the desktop, or **Settings › This computer › Desktop settings** on a phone with full access:

- **Let the assistant use the current date and time** (on by default). When off, nothing about the time is sent and the clock tools are withheld. Timers, schedules and the clock view keep working. History already sent to a provider cannot be recalled.
- **Time zone**: the device sending the message, or a fixed zone.
- **Include time since earlier messages** (on by default). It uses times PAL already records. It does not watch activity.
- **Time display**: system, 12-hour or 24-hour. It changes only how PAL shows times.

The zone and local time are context sent to the model you are talking to, including hosted ones.

## The clock view

**Current date and time** in the command palette (Ctrl+K), **Open the clock** in Settings, and **More › Clock and time zone…** open the same view. It needs no model. It shows the reading, its zone and source, and the conversation’s times, and it marks a reading as old when PAL is reconnecting.

On the phone, the conversation menu’s **Clock and time zone** shows the desktop’s reading in the zone the next message would use. Between checks it moves on with the phone’s interval clock, and it expires. Offline, or with an older desktop, the phone shows its own clock and labels it as such. A phone’s own time is never sent or used.

## What is stored

Each message you send records when it was received and in which zone. Each turn records when it was sent, accepted, first answered and finished, for the last 200 turns of a conversation. Deleting a conversation or forgetting a message removes its times. Temporary conversations keep theirs in memory only. Readings from a previous run of PAL are never compared with this one’s interval clock.

## Limits

- The clock is as right as the desktop’s. PAL reports a jump it sees; it cannot tell which side of a jump was correct.
- Sleep is not measured. An interval that may include it is reported as uncertain.
- A reminder still needs a timer, and a timer needs the desktop awake. Knowing the time schedules nothing.
- Usual size, with PAL’s own estimate (bytes ÷ 2): about 230 tokens for the block, 200 for the fixed guidance and 430 for the two tool definitions. A model with a window of 8,192 tokens or less is not offered the tools, and leaves elapsed fields out of the block (about 120 tokens) when they do not fit.
