# PAL Mobile 2.0.2

Most of this needs PAL 2.0.2 on the desktop and a phone with full access. The app shows only what the paired desktop offers.

## New

- **Providers and accounts.** Start conversations with Grok (xAI), Perplexity, Azure OpenAI, DeepSeek, Mistral, OpenRouter, Hugging Face, LiteLLM, Forge and Eden AI, each with named accounts and its own options. Check an account, see what uses it, move that to another account and remove it. Long model lists can be searched and narrowed, and show price and context in words.
- **Research and services.** Follow Perplexity research jobs and their citations, choose who runs a research question, and continue a result in a conversation. Generate video or music, run Hugging Face inference or Mistral OCR on a file, and manage xAI collections, all through the desktop.
- **Recordings.** Play audio and video beside the time-coded transcript. Search it, correct lines as a new version, ask about a part, make a clip and export subtitles.
- **Documents.** Write one from a template, or export a reply or a file as PDF, Word, a web page or Markdown.
- **References and pinned sources.** Add files, collections and conversations to a message and see what each adds. Pin some to a conversation or its project so they are read again for every message.
- **Work.** New **Shelf** and **Accounts** tabs; analysis sessions that keep their variables; a file's text, a table's shape, text in an image, image details, masks, contact sheets, ZIP bundles and changes to several images; commands in an approved folder; the trash; skills imported from a ZIP. **Conversation settings** can check a result with a saved script.
- **Accounts.** The agenda, mail, files and repositories of a connected Google, Microsoft or GitHub account. Everything written is a draft you review and send yourself. Sign in with a short code.
- **This computer.** Projects and folders, editable setups, tool-server secrets, prompts and resources, standing grants, running jobs, model downloads with the space left, and workspace history.
- **Memory.** Choose the task a conversation works on, decide whether two remembered things are the same, and see the evidence behind a memory.
- **Clock.** The desktop's clock, how long ago the conversation's events were, and a time zone for one conversation.
- **Outside the app.** A Quick Settings tile, a home-screen widget, launcher shortcuts and a conversation on the home screen. Optional wake-ups through a push app you choose, and a search for the desktop on the local network.

## Changed

- Voice controls moved from the chat to **⋮ › Voice settings**. One line above the composer shows a recording, live voice or a reply being read aloud. **Live voice** (OpenAI, Gemini, Grok and Azure OpenAI) appears only where the desktop can start it.
- Delegated results that wait for a conversation are counted in the list and under the conversation.
- A conversation that has a named account is offered only the accounts it can move to.

## Fixed

- Opening **Conversation settings** closed the app on a phone with full access.
- Other ways the app could close itself: repeated rows, answers in an unexpected form, saved screen state or a copy larger than Android accepts, a link no app opens, and very large pictures.
- A sheet swiped away while it was working could leave the app unusable.
- An edit of a desktop file was lost when the phone was turned.
- Answers were dropped while the desktop was busy.
- A new chat with a provider that runs only through a named account starts with that account. Choosing the current account again keeps its options.
- A phone could not connect once the desktop's model lists together passed a megabyte.
- A saved script's time limit set on the phone was sixty times too short.

## Compatibility

PAL Mobile needs Android 11 or later. It still works with older desktops and leaves out what they do not offer. An update signed with the same key keeps the pairing and the encrypted app data.
