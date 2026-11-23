# PAL Mobile before and after

Each pair shows the same journey on the isolated Android emulator. Broker timestamps, generated conversation names and test project paths vary between runs. The fixtures use identical sample text for a closer comparison. [Capture provenance and runtime checks](validation.md)

| Journey | Before | After |
| --- | --- | --- |
| First launch | [Pairing](before/01-pairing-portrait.png) | [Pairing](after/01-pairing-portrait.png) |
| Verify above the keyboard | [Manual offer](before/03-pairing-keyboard.png) | [Manual offer](after/03-pairing-keyboard.png) |
| Conversation list | [Chats](before/13-chats-online.png) | [Chats](after/13-chats-online.png) |
| Reading with the keyboard open | [Conversation](before/19-chat-ime-online.png) | [Conversation](after/19-chat-ime-online.png) |
| Large text and landscape keyboard | [200%](before/21-chat-font200-landscape-ime.png) | [200%](after/21-chat-font200-landscape-ime.png) |
| Streaming reply and composer | [Light](before/fixture-light-streaming.png) · [Dark](before/fixture-dark-streaming.png) | [Light](after/fixture-light-streaming.png) · [Dark](after/fixture-dark-streaming.png) |
| Tool activity failed | [Light](before/fixture-light-activity-failed.png) · [Dark](before/fixture-dark-activity-failed.png) | [Light](after/fixture-light-activity-failed.png) · [Dark](after/fixture-dark-activity-failed.png) |
| Approval review | [Light](before/fixture-light-approval.png) · [Dark](before/fixture-dark-approval.png) | [Light](after/fixture-light-approval.png) · [Dark](after/fixture-dark-approval.png) |
| Desktop controls | [Project scope](before/16-desktop-online.png) | [Project scope](after/16-desktop-online.png) |
| Settings | [Index](before/17-settings-online.png) | [Index](after/17-settings-online.png) |
| Pairing repair | [Light](before/fixture-light-repair.png) · [Dark](before/fixture-dark-repair.png) | [Light](after/fixture-light-repair.png) · [Dark](after/fixture-dark-repair.png) |
| Camera access declined | [Recovery](before/24-camera-denied.png) | [Recovery](after/24-camera-denied.png) |

The live broker produced a partial reply, exposed Stop in the composer, and retained the same partial reply after the phone interrupted the turn. [During streaming](after/26-streaming-stop-light.png) · [After Stop](after/27-stream-stopped-light.png)

The after gallery also covers the exact URL before opening, a required question, submission in progress, an unconfirmed answer, rich Markdown and the owner settings index. [Request link](after/fixture-light-request-link.png) · [Question](after/fixture-dark-request-question.png) · [Submission](after/fixture-light-request-submitting.png) · [Unconfirmed answer](after/fixture-dark-request-unconfirmed.png) · [Markdown](after/fixture-dark-markdown.png) · [Owner settings](after/fixture-light-owner-settings.png)

Browse the [complete baseline](before/) and [complete after gallery](after/) for the remaining states.
