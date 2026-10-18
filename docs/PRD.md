# PRD: Real-Time Collaborative Interview & Pair-Programming Platform

Oct 14, 2026&#32;

## 1. Product overview

This product is a browser-based coding room where two people practice a real coding interview together: they share one live editor, run code safely, and get structured feedback afterwards. Working name: **PairPrep** (placeholder, rename freely).

**One-line pitch:** Mock coding interviews in one link, with a live shared editor, hidden test cases, safe code execution, replay and a scorecard.

**What it is**

- A real-time collaborative code editor built on CRDT-based conflict resolution (Yjs), so simultaneous edits never conflict and cursors are visible live.
- A placement-prep and peer-interview platform with interviewer and candidate roles, a timer, a problem panel and test cases the candidate cannot see.
- A production-quality full-stack system: authenticated, persistent, sandboxed, tested, monitored and deployed for real users at zero hosting cost.

**What it is not**

- Not a LeetCode clone (no global problem library, rankings or contests).
- Not a video-calling tool (voice and video are Phase 4; users can keep a separate call open meanwhile).
- Not a full multi-file IDE (interviews are mostly single-file; a file tree is out of scope for now).
- Not an AI chatbot wrapper (AI hints are Phase 4 and optional).

**Document status:** Draft 1, written 2026-10-14 for a solo builder. Items marked *Proposed* are recommendations awaiting confirmation; they are collected in section 24.

## 2. Problem statement, goals and non-goals

Students preparing for campus placements practice with scattered tools, none of which reproduces a real interview, so they arrive at the real one without ever having coded live while someone watches.

**The gap today**

| Tool students use | What it gives | What is missing |
| --- | --- | --- |
| Coding practice sites | Problems and automatic judging | No live partner, no communication practice |
| Video calls | Voice and screen | No shared editor, no safe execution |
| Shared documents | Simultaneous typing | No code running, no tests, no timer |
| Chat groups | Peer contact | No structure, no feedback |

**Product goals**

1. Let two people start a realistic coding interview within 30 seconds of opening a link, with no installation.
2. Make live editing feel instant: remote edits visible in under 200 ms at the 95th percentile.
3. Run candidate code safely with fixed memory, CPU and time limits, and judge it against hidden test cases.
4. Give both people something to keep: a replayable session and a scorecard.
5. Operate as a real product: authenticated users, persistent data, monitoring, automated tests, deployment pipeline, and real measured usage.

**Personal goals (the builder)**

- Produce a placement-grade portfolio project whose every claim on a resume is backed by a measured number.
- Be able to defend each design decision (CRDT over OT, Docker sandbox, storage choices) in an interview.

**Non-goals**

- Monetization, payments or subscriptions.
- Supporting hundreds of thousands of users; the target is dozens of concurrent rooms on one small free server.
- Mobile-native apps (the web app should be usable on a phone but is designed for a laptop).
- Supporting every programming language; three are enough (Python, C++, JavaScript).

**Definition of success** is in section 25. In short: a live public URL, at least 50 real users, at least 100 completed sessions, a published load-test result, and a clean automated pipeline.

## 3. Target users and personas

The primary user is a second- or third-year engineering student preparing for campus placements, and the first users will be classmates and juniors reached directly. Four personas cover the product.

| Persona | Who they are | Main need | Pain point today | Key features |
| --- | --- | --- | --- | --- |
| Candidate (Aarav) | Student with an upcoming coding round | Practice thinking aloud while coding with someone watching | Practices alone on a site, freezes in live interviews | Timer, hidden tests, run code, replay, scorecard feedback |
| Interviewer (Meera) | Senior or friend giving a mock interview | Run a fair, structured session quickly | Has no tool to see code live, run it and score it | Roles, problem panel, hidden test cases, follow mode, scorecard |
| Peer pair (Rohan and Isha) | Two friends solving a problem together | Pair-program without setup | Screen sharing is clumsy, only one can type | Shared editor, live cursors, chat, run code |
| Builder (the owner) | The solo developer | See usage, errors and health | Cannot tell if the app works for real users | Metrics page, error tracking, uptime alerts |

Persona names are illustrative.

**User needs, in priority order**

1. It must just work from a link: no install, no long signup (guest join allowed).
2. Typing must feel instant and never lose work, even on a weak connection.
3. The interviewer must be able to hide test cases and see the candidate's progress.
4. Both sides must be able to review the session afterwards.
5. Candidate code must never be able to harm the server or other users.

**Assumptions about users (to validate with the first ten testers)**

- Most use a laptop with a recent Chrome, Edge or Firefox.
- Many have unreliable campus or home internet, so reconnect behavior matters.
- Sessions last 30 to 60 minutes and happen in the evening, so traffic is bursty.

## 4. Scope and phasing

The build is split into three committed phases plus one optional phase, ordered so that a working, deployed product exists after Phase 1 and every later phase adds to it. Nothing agreed in earlier discussion has been cut.

| Phase | Theme | What ships | Gate to start the next phase |
| --- | --- | --- | --- |
| 1 | MVP | Login, rooms and roles, live editor with cursors, safe code execution, chat, saved sessions | Two people can complete a full session on the deployed URL |
| 2 | Differentiators | Interview mode with hidden tests, replay, scorecard, problem bank, follow mode | An interviewer can run a complete mock interview end to end |
| 3 | Production hardening | Limits and sandbox hardening, tests, CI/CD, monitoring, load test, documentation, metrics page | Load test passes its targets; pipeline is green |
| 4 | Optional | Video calling and AI hints | Only if time remains after Phase 3 |

**In scope (Phases 1 to 3)**

- Google and GitHub login, plus guest join through a link.
- Rooms with owner, interviewer, candidate and viewer roles.
- Real-time collaborative editing with live cursors and names (Yjs CRDT), plus author attribution that shows who wrote each part of the code.
- Code execution in Python, C++ and JavaScript with stdin and an output panel, sandboxed with fixed limits.
- Room chat and saved sessions.
- Interview mode: timer, problem panel, hidden test cases, automatic judging.
- Session replay with a scrubber, a post-session scorecard with a shareable summary, a starter problem bank on arrays and strings, and follow mode.
- Rate limiting, input validation, automated tests, CI/CD, logging, error tracking, uptime monitoring, load testing, architecture documentation and an internal metrics page.

**Out of scope (for now)**

- Voice and video (Phase 4), AI hints (Phase 4).
- File tree and multi-file projects, a terminal, debugging, package installation.
- User-submitted public problem library, rankings, contests, payments.
- Native mobile apps, email newsletters, social features.

**Design hooks reserved now for Phase 4** are listed in section 9, so that adding video and AI later does not require a rewrite.

## 5. Key user journeys

Five journeys define the product; every functional requirement in sections 6 to 8 traces back to at least one of them.

**J1. Run a mock interview (core journey)**

1. The interviewer signs in with Google or GitHub and clicks *New interview room*.
2. They pick a problem from the bank (or paste their own), choose the language options and a time limit, and create the room.
3. The app shows a share link. The interviewer sends it to the candidate.
4. The candidate opens the link, joins as a guest or signs in, and lands in the lobby showing their role, the time limit and a *Ready* button.
5. The interviewer clicks *Start*. The timer begins, the problem statement appears, and the editor becomes editable for the candidate.
6. Both see each other's cursors. The candidate codes; the interviewer watches, chats and can follow the candidate's view.
7. The candidate clicks *Run* with custom input, then *Submit*. The server runs the code against the hidden tests and shows the candidate only pass or fail counts; the interviewer sees full per-test results.
8. The interviewer ends the session and fills in the scorecard. Both receive a summary page with the final code, test results, scores and a replay link.

**J2. Pair-program with a friend**

1. A user creates a *Practice room* (no roles, no timer, no hidden tests).
2. They share the link; both can edit, run code with their own input and chat.
3. The room remains saved so they can return and continue.

**J3. Recover from a connection drop**

1. A participant loses their connection mid-session.
2. The editor stays usable locally and shows an *Offline, changes will sync* banner.
3. On reconnect, local edits merge automatically with the partner's edits, with nothing lost.

**J4. Review a past session**

1. A user opens *My sessions* and picks a finished session.
2. They see the summary and open the replay, dragging a scrubber to watch the code being written over time.
3. The interviewer can share a read-only summary link with the candidate.

**J5. Owner checks health (builder)**

1. The owner opens the internal metrics page.
2. They see rooms created, active sessions, execution success rate, median sync latency and error counts for the last 7 days.
3. If uptime monitoring or error tracking fires, they receive an email alert.

## 6. Phase 1 (MVP) functional requirements

Phase 1 delivers 58 requirements; every one carries an ID and a testable acceptance criterion. Priority: **P0** = MVP cannot ship without it, **P1** = should ship in Phase 1.

**6.1 Authentication and identity**

| ID | Requirement | Acceptance criteria | Pri |
| --- | --- | --- | --- |
| AUTH-1 | Sign in with Google (OAuth 2.0) | A user with a Google account reaches the dashboard in 3 clicks or fewer; invalid or cancelled flows return to the login page with a clear message | P0 |
| AUTH-2 | Sign in with GitHub (OAuth 2.0) | Same as AUTH-1 for GitHub | P0 |
| AUTH-3 | Guest join through a room link | A person with a link enters a display name and joins within 10 seconds, with no account; guest identity lasts for that browser session | P0 |
| AUTH-4 | Secure sessions | Sessions use httpOnly, secure, same-site cookies; logout invalidates the session server-side; sessions expire after 7 days of inactivity | P0 |
| AUTH-5 | Basic profile | Display name and avatar come from the provider; the user can edit the display name | P1 |

**6.2 Rooms and roles**

| ID | Requirement | Acceptance criteria | Pri |
| --- | --- | --- | --- |
| ROOM-1 | Create a room | An authenticated user creates a room in one click and receives a unique, unguessable link (at least 128 bits of randomness) | P0 |
| ROOM-2 | Join by link | Opening a valid link joins the room; an invalid or deleted room shows a not-found page, not an error | P0 |
| ROOM-3 | Roles | Room has owner, editor and viewer roles in Phase 1; the owner can change a participant's role and the change applies live within 1 second | P0 |
| ROOM-4 | Participant limit | A room holds at most 6 participants; the 7th sees a *Room full* message | P1 |
| ROOM-5 | Participant list | Everyone sees who is present, with name, color and role, updating live | P0 |
| ROOM-6 | Room lifecycle | Owner can end or delete a room; ended rooms become read-only; rooms inactive for 30 days are archived | P1 |

**6.3 Real-time editor**

| ID | Requirement | Acceptance criteria | Pri |
| --- | --- | --- | --- |
| ED-1 | Monaco editor with syntax highlighting | Python, C++ and JavaScript highlight correctly; language selectable per room | P0 |
| ED-2 | Conflict-free live editing | Two users typing in the same line concurrently end with identical text on both screens, with neither user's characters lost, in 100 out of 100 automated trials | P0 |
| ED-3 | Live cursors and selections | Each remote user's cursor and selection show in a distinct color with a name label, updating in under 200 ms at the 95th percentile | P0 |
| ED-4 | Sync latency | Remote edit visible in under 200 ms at the 95th percentile on a normal broadband connection (measured, see section 19) | P0 |
| ED-5 | Offline tolerance | Disconnected edits stay in the local editor and merge on reconnect without data loss; a banner shows connection state | P0 |
| ED-6 | Read-only for viewers | Viewers cannot modify the document; attempts are rejected by the server, not just the UI | P0 |
| ED-7 | Editor preferences | Superseded by UIX-3 to UIX-7 in section 6.8: appearance settings persist per user | P1 |

**6.4 Code execution**

| ID | Requirement | Acceptance criteria | Pri |
| --- | --- | --- | --- |
| EX-1 | Run code in Python, C++ and JavaScript | Hello-world and a standard-input echo program return correct output in each language | P0 |
| EX-2 | Custom standard input | The user enters stdin text; the program reads it; stdout and stderr are shown separately | P0 |
| EX-3 | Hard resource limits | Each run is capped at 5 seconds wall time, 128 MB memory, 1 CPU share, 1 MB of output, no network, no persistent filesystem; exceeding a limit shows a clear verdict (Time Limit, Memory Limit, Output Limit) | P0 |
| EX-4 | Isolation | Every run executes in a fresh, disposable container; two runs cannot see each other's files; tests in section 15 (fork bomb, infinite loop, network call, file read outside the sandbox) all fail safely | P0 |
| EX-5 | Compile errors shown | A C++ compile error shows the compiler message with line numbers | P0 |
| EX-6 | Run queue and concurrency cap | At most 2 runs execute at once; extra runs queue, show queue position, and time out after 30 seconds in the queue | P0 |
| EX-7 | Shared output | The run result appears for every participant in the room, labelled with who ran it | P1 |

**6.5 Chat, persistence and basics**

| ID | Requirement | Acceptance criteria | Pri |
| --- | --- | --- | --- |
| CH-1 | Room chat | Messages appear for all participants in under 500 ms; messages are capped at 1,000 characters | P0 |
| CH-2 | Chat history | A user who joins late or reloads sees the last 200 messages | P1 |
| CH-3 | System messages | Join, leave and role-change events appear in the chat stream | P1 |
| PER-1 | Document persistence | Closing all browsers and reopening the link restores the exact code; server restart loses at most the last 2 seconds of edits | P0 |
| PER-2 | My rooms | A signed-in user sees a list of rooms they own or joined, newest first | P0 |
| PER-3 | Export | The user can download the current code as a file with the right extension | P1 |
| UI-1 | Responsive layout | Usable at widths from 1024 px up; read-only usable down to 360 px | P1 |
| UI-2 | Error and empty states | Every screen has loading, empty and error states with a clear next action | P0 |

**6.6 Concurrency and idempotency**

| ID | Requirement | Acceptance criteria | Pri |
| --- | --- | --- | --- |
| CONC-1 | Many writers at once | Up to 6 participants type into the same document at the same time and every client ends with identical text; 6 simulated clients typing for 60 seconds converge in 100 of 100 trials | P0 |
| CONC-2 | Duplicate delivery is harmless | Applying the same Yjs update twice (for example after a reconnect) leaves the document unchanged; a test sends every update twice and compares the result with a single delivery | P0 |
| CONC-3 | Idempotent writes | Create room, submit, save scorecard and change role accept an idempotency key; repeating a request with the same key within 24 hours returns the first result and creates no second record or judging job | P0 |
| CONC-4 | Fair concurrent runs | Run requests from several people at once are served first come, first served; no more than 2 execute together; each result goes to the person who asked and is visible to the room | P0 |

**6.7 Live change indicators (seeing who is writing, as it happens)**

When another person types, the editor must make it obvious that the code is changing and who is changing it, without disturbing the person who is typing. These indicators are temporary and fade; the persistent record of who wrote what is the Show authors feature (ATTR-1 to 8 in section 7.6).

| ID | Requirement | Acceptance criteria | Pri |
| --- | --- | --- | --- |
| LIVE-1 | Remote edit highlight | Text inserted or changed by another participant is highlighted in that person's color for 2 seconds and then fades; your own edits are never highlighted; in an automated test the highlight appears within 200 ms at the 95th percentile with the correct author's color and is gone within 3 seconds | P0 |
| LIVE-2 | Cursor name flag | A remote cursor shows a flag with the person's name while they are active and for 3 seconds after their last action, then shrinks to a small colored bar | P0 |
| LIVE-3 | Typing indicator | The participant list and the chat footer show who is typing, for example "Meera is typing" or "Meera and Rohan are typing"; it appears within 300 ms of a keystroke and disappears 2 seconds after the last one | P0 |
| LIVE-4 | Gutter marker | Lines that another person is editing show a thin bar in that person's color with their initial in the margin, cleared after 3 seconds without edits | P0 |
| LIVE-5 | Off-screen activity cue | When someone edits outside your visible area, an indicator at the top or bottom edge says who and which line, with an arrow; clicking it scrolls there; your view is never moved automatically | P1 |
| LIVE-6 | Never disturb the typist | While you type, remote edits above or below your cursor never move your cursor or selection and never jump your view; in an automated test a remote client inserts 10 lines above the local caret and the caret stays on the same text | P0 |
| LIVE-7 | Calm and accessible | A reduced-motion setting replaces the fade with a static marker for 2 seconds; colors come from a color-blind-safe palette and always come with initials; screen readers get a polite announcement at most once every 5 seconds (for example "Meera edited lines 10 to 12"); a setting turns remote highlights off | P1 |
| LIVE-8 | Bulk changes | A remote change of more than 20 lines (for example a paste) shows one notice such as "Meera pasted 35 lines" with a jump button, instead of flashing the whole range | P1 |

**How it works:** the highlight and the gutter marker come from the incoming Yjs update, which says which text changed and which participant it came from; the typing indicator and name flag come from awareness data (section 13.2). Nothing here needs extra storage.

**6.8 Editor interface, themes, fonts and text size**

The room should feel as polished as the tools students already use: the layout takes its ideas from LeetCode (a problem panel and an editor side by side, with a console below, all in resizable panes) and the editor takes its feel from VS Code (familiar shortcuts, minimap, find and replace, a status bar). These are inspiration only; nothing is copied (UIX-13). Every appearance choice below belongs to the person who makes it and never changes a partner's screen.

| ID | Requirement | Acceptance criteria | Pri |
| --- | --- | --- | --- |
| UIX-1 | Resizable panes | Problem panel, editor, console and chat/participants sit in panes with drag handles; each can be collapsed and restored; minimum sizes stop panes from disappearing by accident; the layout is saved per user and a *Reset layout* command restores the default; dragging stays smooth with no broken layout | P0 |
| UIX-2 | VS Code-style editor | Monaco with line numbers, minimap, bracket matching and colored bracket pairs, indent guides, current-line highlight, code folding, find and replace (Ctrl+F and Ctrl+H), multi-cursor (Alt+click), and common VS Code shortcuts; a status bar shows line and column, language, connection state and who is present; a checklist of 15 named shortcuts passes a manual test | P0 |
| UIX-3 | Themes | At least 8 themes, each styling both the editor and the app interface: Light, Dark, High-contrast dark, High-contrast light, Solarized Light, Solarized Dark, Dracula and Nord (One Dark optional); a *Match system* option follows the operating system; switching applies in under 100 ms with no reload and no flash | P0 |
| UIX-4 | Fonts | A picker with live preview offers at least 6 monospace fonts plus the system default: JetBrains Mono, Fira Code, Source Code Pro, Cascadia Code, Roboto Mono and IBM Plex Mono; a ligatures toggle; fonts are hosted by the app itself and only the chosen font is downloaded; a fallback font shows text immediately while a font loads | P0 |
| UIX-5 | Text size | Editor font size from 10 to 32 px (default 14) by slider and by Ctrl+Plus, Ctrl+Minus and Ctrl+0 to reset; line spacing choices compact, normal and relaxed; interface scale from 80% to 150%; changes appear within 100 ms and cursors, selections and remote cursor flags stay aligned with the text at every size | P0 |
| UIX-6 | Personal, not shared | Theme, font, size and editor options are per person; in a test with two browsers using different themes, fonts and sizes, each keeps its own and neither affects the other | P0 |
| UIX-7 | Settings drawer | A gear icon opens a drawer with Theme, Font, Size and Editor sections (tab size 2, 4 or 8; spaces or tabs; word wrap; minimap; line numbers; bracket colors), a live preview snippet, and *Reset to defaults*; signed-in users' settings follow them across devices; guests keep theirs in the browser | P0 |
| UIX-8 | Command palette | Ctrl+Shift+P (or F1) opens a searchable list of commands such as change theme, change font, increase text size, toggle minimap, run code and toggle panels | P1 |
| UIX-9 | Autocomplete control | Autocomplete and parameter hints are on by default in practice rooms; in an interview room the interviewer can switch them off for the candidate, and the setting is visible to both | P1 |
| UIX-10 | Keymaps | The default keymap is VS Code style; an optional Vim mode can be turned on in the settings drawer | P1 |
| UIX-11 | Design system and polish | One set of design tokens (colors, spacing, type scale, corner radius), one icon set and a shared component library; skeleton placeholders while loading; 150 to 200 ms transitions that respect the reduced-motion setting; mockups of the landing page, room and summary are reviewed before building; automated accessibility score of 90 or more on main screens and layout shift below 0.1 on room load | P1 |
| UIX-12 | Interface performance | The editor and its language support load only when a room opens; the room is interactive in under 3 seconds on broadband; typing feels immediate (local keystroke to screen under 50 ms) with 6 participants; the app code outside the editor stays within a size budget set in week 1 | P1 |
| UIX-13 | Inspiration without copying | Ideas from LeetCode and VS Code are used for layout and interaction only; no copied logos, icons, text, code or themes with unclear licenses; every theme, font and icon set uses an open license, listed in a third-party notices file in the repository | P0 |

**Theme and font licensing:** Monaco includes built-in light, dark and high-contrast themes; the other themes are defined by the app from openly licensed color palettes, and each font is distributed under an open font license. The license of each item is checked and recorded when it is added, because licenses and file sizes are not verified in this document.

**Why settings stay personal:** two people in the same room often want different things (one wants a large font on a projector, another a dark theme). Sync affects only the shared code, never presentation.

## 7. Phase 2 (differentiators) functional requirements

Phase 2 turns the shared editor into an interview product; it delivers 34 requirements across six features. The hidden-test rule (INT-5) is the most security-sensitive item in this phase.

**7.1 Interview mode**

| ID | Requirement | Acceptance criteria | Pri |
| --- | --- | --- | --- |
| INT-1 | Interview room type | Creating a room offers *Practice* or *Interview*; interview rooms have exactly one interviewer and one candidate | P0 |
| INT-2 | Lobby and ready check | Before start, both see role, time limit and a Ready toggle; Start is enabled for the interviewer only when the candidate is Ready | P0 |
| INT-3 | Server-authoritative timer | The countdown is computed from a server timestamp, so two browsers never differ by more than 1 second; the interviewer can pause and extend it | P0 |
| INT-4 | Problem panel | Statement, constraints and sample cases render in a side panel with Markdown formatting; visible to both | P0 |
| INT-5 | Hidden tests stay hidden | Hidden test inputs and expected outputs are never sent to the candidate's browser; a network inspection of a candidate session finds none of them | P0 |
| INT-6 | Submit and judge | Submit runs the code against all tests in the sandbox; the candidate sees only passed count and verdict category per test; the interviewer sees input, expected output and actual output | P0 |
| INT-7 | Editor locking | The candidate's editor is read-only before Start and after End; the interviewer chooses whether they can edit during the session | P1 |
| INT-8 | End session | Interviewer ends the session, or the timer expires; the room becomes read-only and the summary opens for both | P0 |

**7.2 Problem bank**

| ID | Requirement | Acceptance criteria | Pri |
| --- | --- | --- | --- |
| PB-1 | Starter problem set | At least 8 original or properly-licensed array and string problems, each with statement, constraints, 2 sample cases and at least 6 tests (3 or more hidden) | P0 |
| PB-2 | Difficulty tags | Each problem is tagged easy, medium or hard and by topic; the picker can filter | P1 |
| PB-3 | Reference solution validation | Every bank problem has a reference solution that passes all of its tests in CI; a failing problem blocks deployment | P0 |
| PB-4 | Custom problems | An interviewer can paste their own statement and add tests (input and expected output); custom tests are validated for size limits | P1 |

Problem content must be original or clearly licensed; copying problem statements from commercial platforms is not allowed.

**7.3 Session replay**

| ID | Requirement | Acceptance criteria | Pri |
| --- | --- | --- | --- |
| RP-1 | Record changes with timestamps | Every document update is stored with a server timestamp and author, in an append-only log | P0 |
| RP-2 | Replay player | A scrubber, play and pause, and 1x, 2x and 4x speed reproduce the code as it was at any moment | P0 |
| RP-3 | Event markers | Run, submit, chat and join events appear as markers on the scrubber | P1 |
| RP-4 | Exactness | The final replay frame equals the saved final document, byte for byte, in an automated test | P0 |
| RP-5 | Access control | Only participants (and holders of a share link) can replay; replay of a deleted room is impossible | P0 |
| RP-6 | Log compaction | Update logs older than 30 days compact into periodic snapshots to control storage; replay of compacted ranges still works at snapshot granularity | P1 |

**7.4 Scorecard and summary**

| ID | Requirement | Acceptance criteria | Pri |
| --- | --- | --- | --- |
| SC-1 | Scorecard form | Interviewer rates problem solving, code quality, communication and edge-case handling from 1 to 5 and adds free-text comments; the form autosaves | P0 |
| SC-2 | Summary page | After the session, both see final code, test results, time used, scores and comments | P0 |
| SC-3 | Share link | The interviewer can create or revoke a read-only summary link; a revoked link returns not-found immediately | P1 |
| SC-4 | Markdown export | The summary downloads as a Markdown file | P1 |
| SC-5 | Candidate self-reflection | The candidate can add private notes to their own copy of the summary | P1 |

**7.5 Follow mode**

| ID | Requirement | Acceptance criteria | Pri |
| --- | --- | --- | --- |
| FM-1 | Follow a participant | Clicking a participant's name makes the local view track their cursor and scroll position within 300 ms | P1 |
| FM-2 | Exit on manual scroll | Scrolling or clicking in the editor stops following and shows a brief notice | P1 |
| FM-3 | Follow indicator | The followed user sees a small indicator that someone is following them | P1 |

**7.6 Authorship attribution (who wrote which part)**

The editor shows who wrote each part of the code, live and in the final summary. Attribution is per inserted character and comes from the server's record of which authenticated user owns each Yjs connection, so it cannot be forged from the browser.

| ID | Requirement | Acceptance criteria | Pri |
| --- | --- | --- | --- |
| ATTR-1 | Trusted author mapping | The server maps every sync connection's Yjs client ID to the authenticated user or guest and stores it (client\_map in section 12); a browser that claims another identity or client ID cannot change attribution, proven by a test | P0 |
| ATTR-2 | Show authors toggle | A toggle tints each participant's text in their color and shows their initial in the gutter; with 3 users each typing a separate block, every block shows the correct author in an automated check; the choice persists per user | P0 |
| ATTR-3 | Hover for the author | Hovering or focusing text shows the author's name in a tooltip within 200 ms; also reachable by keyboard | P0 |
| ATTR-4 | Legend and palette | A legend lists each participant with their color; colors come from a color-blind-safe palette and are always paired with initials, never color alone | P1 |
| ATTR-5 | Contribution breakdown | The summary shows each author's share of the final characters and lines (shares sum to 100% within 1 point) and a per-line author column on the read-only final code, verified against a reference calculation | P0 |
| ATTR-6 | Attribution in replay | During replay, text added at each step is tinted by author and the legend stays visible | P1 |
| ATTR-7 | Pasted and automatic text | Pasted text counts for the person who pasted; automatic formatting counts for the person who triggered it; the help text states both rules | P1 |
| ATTR-8 | Same person, many tabs | One user with two tabs, or after a reconnect, is one author with one color; two guests with the same display name stay separate authors | P0 |

**Rules and limits:** a line edited by two people shows mixed colors; text that was deleted is not shown in the live view (replay can show it); attribution is visible to everyone in the room, and guests appear under their display name.

**Design to confirm in a one-day prototype in week 2:** read the author from the client ID that Yjs already stores on every inserted piece of text, mapped to users through client\_map. If that proves awkward with the Monaco binding, fall back to storing authored ranges in a side structure.

## 8. Phase 3 (production hardening) requirements

Phase 3 does not add user-facing features; it makes the product trustworthy, and it delivers 31 requirements. Numeric targets here are goals to be confirmed by measurement on the real server, not guarantees.

**8.1 Security and abuse control**

| ID | Requirement | Acceptance criteria | Pri |
| --- | --- | --- | --- |
| SEC-1 | Rate limiting | Per user and per IP: API 100 requests per minute, code runs 10 per minute, room creation 10 per hour, chat 20 messages per 10 seconds; excess returns HTTP 429 with a retry hint | P0 |
| SEC-2 | Input validation | Every endpoint and WebSocket message is validated against a schema; unknown fields and oversized payloads are rejected | P0 |
| SEC-3 | Web security basics | CORS allowlist, CSRF protection for cookie-authenticated writes, HSTS, a content security policy and other standard security headers; an online header scan grades A or better | P0 |
| SEC-4 | Sandbox hardening | Containers run as non-root with all capabilities dropped, read-only root filesystem, no network, process count limit and default seccomp profile; the escape test suite in section 14 passes | P0 |
| SEC-5 | Secrets handling | No secret exists in the repository or logs; secret scanning runs in CI and blocks the build on a hit | P0 |
| SEC-6 | Dependency hygiene | Automated weekly dependency update checks and vulnerability audit; no known critical vulnerability at release | P1 |
| SEC-7 | Moderation tools | The room owner can remove a participant; the owner of the app can disable an abusive account | P1 |

**8.2 Quality and delivery**

| ID | Requirement | Acceptance criteria | Pri |
| --- | --- | --- | --- |
| QA-1 | Unit tests | Server logic (roles, timer, judging, rate limits) reaches at least 70% line coverage, with the judging and role logic above 90% | P0 |
| QA-2 | Integration tests | API and WebSocket flows run against a real database and a real sandbox in CI | P0 |
| QA-3 | End-to-end tests | An automated two-browser scenario completes a full interview (J1) and passes on every merge | P0 |
| QA-4 | CI pipeline | Every pull request runs lint, type check, tests and build; merging is blocked on failure | P0 |
| QA-5 | CD with rollback | Merging to the main branch deploys automatically; a failed post-deploy health check restores the previous version | P1 |
| QA-6 | Accessibility checks | Automated accessibility scan reports no critical violations on the main screens | P1 |

**8.3 Performance**

| ID | Requirement | Acceptance criteria | Pri |
| --- | --- | --- | --- |
| PERF-1 | Load test | A scripted test with 25 concurrent rooms (50 connections) typing continuously for 10 minutes keeps 95th-percentile sync latency under 200 ms and error rate under 1%; results are saved in the repository | P0 |
| PERF-2 | Soak test | A 2-hour run at 10 rooms shows no growth in memory use beyond 10% and no crashes | P1 |

**8.4 Observability and metrics**

| ID | Requirement | Acceptance criteria | Pri |
| --- | --- | --- | --- |
| OBS-1 | Structured logging | JSON logs carry a request ID, user ID (hashed) and room ID; no source code or chat text is logged | P0 |
| OBS-2 | Error tracking | Frontend and backend errors reach an error-tracking service with release version attached | P0 |
| OBS-3 | Uptime monitoring | An external monitor checks the app every 5 minutes and emails the owner after 2 consecutive failures | P0 |
| OBS-4 | Health endpoint | A health route reports database, sandbox and queue status in one call | P0 |
| OBS-5 | Runtime metrics | The server exposes counts and timings for rooms, connections, sync latency, run duration and verdicts | P1 |
| MET-1 | Owner metrics page | A page visible only to the owner shows the product and engineering metrics listed in section 20 for the last 7 and 30 days | P0 |

**8.5 Documentation and operations**

| ID | Requirement | Acceptance criteria | Pri |
| --- | --- | --- | --- |
| DOC-1 | README | A new developer runs the whole stack locally in under 10 minutes by following it | P0 |
| DOC-2 | Architecture diagram | The diagram in section 10 is kept in the repository and current | P0 |
| DOC-3 | Decision records | At least 6 short records explain key choices (CRDT over OT, sandbox design, storage, hosting, auth, rate limits) | P0 |
| DOC-4 | API reference | REST endpoints and WebSocket events are documented | P1 |
| DOC-5 | Runbook | Steps for deploy, rollback, restoring a backup and handling a sandbox incident | P1 |
| OPS-1 | Backups | The database is backed up daily; a restore is rehearsed once and timed | P0 |
| OPS-2 | Graceful restarts | Restarting the server lets in-progress edits flush and clients reconnect within 10 seconds | P0 |
| OPS-3 | Reproducible builds | Dependencies are pinned and containers are built from a lockfile | P1 |
| OPS-4 | Data deletion | A user can delete their account and rooms; data is removed within 30 days | P1 |
| OPS-5 | Legal basics | A short terms and privacy page states what is stored and for how long | P1 |

## 9. Phase 4 (optional): video calling and AI hints

Phase 4 starts only after Phase 3 passes its gate, and the Phase 1 to 3 design must leave room for it so that nothing needs rewriting. Phase 4 is not committed; the requirements below are intent, to be detailed later.

**Candidate features**

| ID | Feature | Intent | Main risk |
| --- | --- | --- | --- |
| P4-1 | Voice and video | Browser-to-browser calls using WebRTC inside the room, with mute, camera toggle and screen share | Needs a signalling channel and a relay server for users behind strict networks, which may cost money |
| P4-2 | AI hints | An opt-in hint button gives a nudge without revealing the full solution; the interviewer can disable it per room | Usage cost, abuse, and leaking solutions |
| P4-3 | Complexity feedback | After submission, a short analysis of time and space complexity | Wrong analysis; must be labelled as a suggestion |

**Design hooks to build in now (cheap, and avoid rewrites)**

1. **Generic room events.** Store room activity as typed events (join, leave, run, submit, chat, timer) in one event table, so adding *hint requested* or *call started* later is a new type, not a new schema.
2. **Signalling-ready WebSocket layer.** Keep the real-time gateway able to relay small targeted messages between two participants, which WebRTC signalling needs.
3. **Feature flags.** A per-room settings object (JSON) holds switches such as hints enabled; unknown keys are ignored, so older clients do not break.
4. **Pluggable execution and AI providers.** Code execution and any future AI call sit behind interfaces, so providers can change without touching room logic.
5. **Cost and abuse guard rails.** Rate-limit and quota code written in Phase 3 is reusable for hint requests.

A third-party free relay (TURN) service and any AI provider with a free allowance must be checked for current limits at the time Phase 4 starts; neither is assumed to be free here.

## 10. System architecture

The backend is a single Node process behind a Caddy proxy on one Azure VM, with the app served from static hosting, data in a managed database, and a fresh sandbox container created for every code run.

&#91;embedded content: system architecture · 5 components on one VM, 3 external services\]

The highlighted box is the VM and holds everything that executes server code. Arrows show who calls whom: the browser reaches the VM through HTTPS and WebSocket on port 443, the monitor calls the health endpoint, and backups leave the VM once a day.

**Data flow for one edit**

1. The user types; the local Yjs document applies the change instantly.
2. The change travels over the WebSocket through Caddy to the sync server.
3. The server checks the connection's role, appends the update to the log in the database, and broadcasts it.
4. Other participants apply the update; the target is under 200 ms at the 95th percentile.

**Data flow for one run**

1. The browser calls the run endpoint; the API checks role, rate limit and payload size.
2. The request waits in the in-process queue for one of two run slots.
3. The runner creates a disposable container, runs the code, enforces the limits and removes the container.
4. The result returns to every participant through the room-events channel.

**Trust boundaries**

- Everything in the browser is untrusted; the server re-checks every role and rule.
- Only ports 80 and 443 are open to the internet; the database and the Docker engine are not reachable from outside.
- Sandbox containers cannot reach the network, the host files or the Docker engine.

**Failure behavior (design intent):** if the database is unreachable, connected rooms keep editing in memory and flush when it returns, while new logins and new rooms show a clear error; if the runner fails, editing and chat continue and only Run is disabled.

## 11. Technology stack

The stack is MERN-based with TypeScript, chosen for the builder's existing strength, a single always-on Azure VM for the backend, and the hard limit of about 1 GB of RAM on that VM. Items marked **Agreed** were decided in discussion; items marked **Proposed** are recommendations to confirm (section 24).

| Layer | Choice | Why | Alternatives considered | Status |
| --- | --- | --- | --- | --- |
| Frontend framework | React with Vite and TypeScript | Builder knows React; Vite builds fast; TypeScript is the industry norm | Next.js (heavier, server rendering not needed) | Proposed |
| Styling | Tailwind CSS | Fast, consistent UI with little custom CSS | Plain CSS modules | Proposed |
| Code editor | Monaco Editor | The VS Code engine; familiar feel for interviews; mature Yjs binding | CodeMirror 6 (lighter, better on mobile) | Proposed |
| Conflict resolution | Yjs (CRDT) with the Monaco binding and awareness for cursors | Edits merge without a central lock; supports offline editing and keeps a replayable update history | Operational transformation (needs a central server and is harder to build correctly) | Proposed |
| Sync server | Hocuspocus (Yjs WebSocket server) | Built for production: authentication hooks, persistence hooks, read-only connections | y-websocket (simpler, fewer hooks) | Proposed |
| Room events | Socket.IO in the same Node process | Familiar to the builder; rooms, reconnection and acknowledgements built in; used for chat, timer, roles, run results | Reuse Hocuspocus messages only (fewer moving parts) | Proposed |
| Backend | Node.js LTS with Express and TypeScript | Same language as the frontend; the builder is strong in it | NestJS (more structure, more memory) | Proposed |
| Validation | Zod schemas shared by frontend and backend | One source of truth for request shapes | Joi, hand-written checks | Proposed |
| Authentication | OAuth 2.0 for Google and GitHub through Passport, with server-side sessions in httpOnly cookies | No password storage; standard flow | Auth0 or Clerk (external dependency and limits) | Proposed |
| Database | MongoDB Atlas free tier with Mongoose | Builder knows MongoDB; documents fit rooms, events and update logs; free tier needs no payment card (to verify at signup) | PostgreSQL on a free host (better for relational integrity) | Proposed |
| Rate limiting and queue | In-process (memory) for the first version | Saves RAM on a 1 GB VM; one server process makes this correct | Redis with BullMQ (add only when running more than one process) | Proposed |
| Code execution | Own runner: one disposable Docker container per run, with fixed limits | Matches the Docker isolation approach; lightweight on 1 GB | Self-hosted Judge0 (heavier: needs a database, queue and workers) | Proposed, to be confirmed by a one-day spike |
| Backend hosting | Azure for Students credit, Linux B1s VM (free-eligible size), Docker Compose | No payment card needed; a real server with Docker | Oracle free tier (needs a card), Render free (sleeps) | Agreed |
| Frontend hosting | Cloudflare Pages or Vercel (free static hosting, never sleeps) | Keeps the frontend off the VM | GitHub Pages | Proposed |
| HTTPS and proxy | Caddy (automatic certificates) | Simplest correct HTTPS setup | Nginx with certbot | Proposed |
| Containers and registry | Docker, GitHub Container Registry | Free for public repositories | Docker Hub | Proposed |
| CI/CD | GitHub Actions | Free for public repositories; runs tests and deploys | None | Proposed |
| Testing | Vitest, Supertest, Playwright, k6 | Unit, API, two-browser end-to-end and WebSocket load tests | Jest, Cypress | Proposed |
| Monitoring | Sentry (errors), UptimeRobot (uptime), pino (logs) | Free tiers cover the needs | Grafana Cloud, Datadog | Proposed |

**Language choice for the sandbox images:** Python, C++ (GCC) and Node.js images, pre-pulled on the VM so a run never waits for a download.

**Free-tier facts must be re-checked on the day each account is created.** Free limits for MongoDB Atlas, Cloudflare, Sentry and UptimeRobot are not verified in this document; each is a to-do in section 18.

## 12. Data model

The data model has 14 collections; the two that grow fastest, document updates and events, are append-only and are compacted on a schedule. Field lists are the minimum; names follow MongoDB conventions (underscore id, ISO timestamps in UTC).

| Collection | Key fields | Notes, indexes and retention |
| --- | --- | --- |
| users | id, provider (google or github), providerId, displayName, avatarUrl, email, role (user or owner-admin), createdAt, disabled | Unique index on provider plus providerId; email not shown to others; deleted on account deletion |
| guests | id, displayName, roomId, createdAt, expiresAt | Short-lived; auto-expires after 7 days (time-to-live index) |
| sessions | id, userId, createdAt, lastSeenAt, expiresAt | Server-side session store; time-to-live index on expiresAt (7 days idle) |
| rooms | id, slug (unguessable), type (practice or interview), ownerId, language, status (open, live, ended, archived), settings (JSON), problemId, timeLimitSec, startedAt, endedAt, createdAt | Index on ownerId plus createdAt; slug has at least 128 bits of randomness; archived after 30 days idle |
| room\_members | roomId, userId or guestId, role (owner, interviewer, candidate, editor, viewer), joinedAt, lastSeenAt | Unique on roomId plus member; limit 6 per room |
| doc\_updates | roomId, seq, authorId, ts, update (binary), size | Append-only; index on roomId plus seq; basis of replay; older than 30 days compacted into snapshots |
| doc\_snapshots | roomId, seq, ts, state (binary), text | Written every 5 minutes of activity and at session end; the latest snapshot is what a reopened room loads first |
| messages | id, roomId, authorId, text, ts, kind (user or system) | Capped at 1,000 characters; the last 200 are loaded on join; deleted with the room |
| problems | id, title, statementMd, difficulty, topics, constraintsMd, samples, starterCode (per language), source, ownerId (null for bank), visibility | Bank problems have no owner; custom problems are private to their owner |
| problem\_tests | id, problemId, input, expected, isHidden, timeLimitMs, order | Stored in a separate collection and never serialized into a participant-facing response when isHidden is true |
| submissions | id, roomId, userId, language, codeHash, ts, verdictSummary, perTest (array of verdict, timeMs, memKb), judgedBy | Index on roomId plus ts; full source is not duplicated here, only a hash and the snapshot reference |
| scorecards | id, roomId, interviewerId, candidateId, scores (object), comments, submittedAt, shareToken, shareRevokedAt | One per interview room; share token is random and revocable |
| events | id, roomId, userId, type (join, leave, run, submit, chat, timer, role-change), payload, ts | Generic event log for replay markers, metrics and Phase 4 additions; kept 90 days, then aggregated |
| client\_map | roomId, clientId (Yjs), userId or guestId, connectedAt | Written by the server when a connection opens, never by the browser; index on roomId plus clientId; kept as long as the room's update log because attribution needs it; deleted with the room |

**Rules**

1. Hidden test content leaves the database only inside the judging service, never in any response to a candidate (INT-5).
2. The authorization check runs on the server for every read and write; client-side checks are for usability only.
3. Deleting a room cascades to its updates, snapshots, messages, submissions, scorecards and events within 30 days (OPS-4).
4. Source code and chat text are personal content; they are stored for the product but never written to logs or error reports (OBS-1).

**Storage budget (to be measured):** The free database tier has a fixed size cap that must be confirmed at signup. A working target is under 5 MB of raw updates for a one-hour session, and under 1 MB after compaction. The first load test measures the real figure and the compaction schedule is tuned from it.

## 13. API design and real-time protocol

The system has three channels: a REST API for accounts and records, a Yjs WebSocket for document sync, and a Socket.IO channel for room events. All three authenticate from the same session cookie (or a signed guest token) and enforce the same role rules on the server.

**13.1 REST API (versioned under /api/v1)**

| Method and path | Purpose | Who may call it |
| --- | --- | --- |
| GET /auth/google, GET /auth/github | Start the OAuth flow | Anyone |
| GET /auth/callback/:provider | Finish login and set the session cookie | Anyone |
| POST /auth/logout | Destroy the session | Signed in |
| GET /me | Current user profile | Signed in |
| PATCH /me | Change display name | Signed in |
| DELETE /me | Delete account and data | Signed in |
| POST /rooms | Create a room (type, language, problem, time limit) | Signed in |
| GET /rooms | List my rooms | Signed in |
| GET /rooms/:slug | Room metadata and my role (no hidden tests) | Member or link holder |
| POST /rooms/:slug/join | Join as signed-in user or guest (with name) | Anyone with the link |
| PATCH /rooms/:slug/members/:id | Change a member's role | Owner |
| DELETE /rooms/:slug/members/:id | Remove a member | Owner |
| POST /rooms/:slug/end | End the session | Owner or interviewer |
| DELETE /rooms/:slug | Delete the room | Owner |
| POST /rooms/:slug/run | Run code with stdin; returns a run ID | Editor roles |
| POST /rooms/:slug/submit | Judge against all tests | Candidate |
| GET /runs/:id | Run status and output | Room members |
| GET /problems | List and filter the bank | Signed in |
| POST /problems | Create a custom problem with tests | Signed in |
| GET /rooms/:slug/summary | Summary, results and scorecard | Participants or share link |
| PUT /rooms/:slug/scorecard | Save the scorecard | Interviewer |
| POST and DELETE /rooms/:slug/share | Create or revoke the share link | Interviewer |
| GET /rooms/:slug/replay | Page through timestamped updates for replay | Participants or share link |
| GET /healthz | Database, sandbox and queue status | Public (minimal) |
| GET /admin/metrics | Product and engineering metrics | Owner only |

Errors use one JSON shape: a stable error code, a human message and a request ID. Lists are paginated. Writes that may be retried carry an idempotency key.

**13.2 Document sync (Yjs over WebSocket)**

1. The client opens a WebSocket to the sync server with the document name equal to the room ID.
2. On connect, the server authenticates the cookie or guest token, looks up the member's role, sets the connection read-only for viewers and for candidates before Start, and records which user owns this connection's Yjs client ID (used for authorship, ATTR-1).
3. The server loads the latest snapshot plus later updates, then exchanges Yjs sync messages with the client.
4. Each accepted update is appended to the update log with a timestamp, then broadcast to peers.
5. Cursor, selection, name, color and last-edit time travel as awareness state, which is not stored; the last-edit time drives the typing indicator (LIVE-3).
6. On reconnect the client sends its state vector and receives only what it missed.

**13.3 Room events (Socket.IO)**

| Event | Direction | Payload and rule |
| --- | --- | --- |
| room:join, room:leave | Server to clients | Member joined or left; presence list updated |
| chat:send, chat:message | Client to server, then broadcast | Text up to 1,000 characters, rate limited |
| timer:start, timer:pause, timer:extend, timer:sync | Interviewer to server, then broadcast | Server timestamp and remaining seconds; clients display from server time |
| session:start, session:end | Interviewer to server, then broadcast | Locks or unlocks editing, opens the summary |
| role:changed | Server to clients | New role applies immediately, including the sync connection |
| run:queued, run:started, run:finished | Server to clients | Position in queue, then verdict and output |
| submit:result | Server to clients | Candidates receive counts only; interviewer receives full detail |
| follow:start, follow:stop | Client to server, then to target | Notification only; scroll sync is client-side from awareness data |

**Rules for every channel:** the server never trusts a client-supplied role, user ID or timestamp; unknown event names are dropped; each socket has a message rate limit; and a disconnected client is removed from presence within 30 seconds.

## 14. Code execution sandbox design

Every run happens in a brand-new Docker container that is destroyed immediately afterwards, with memory, CPU, time, process and output limits set in advance and no network. This is the same isolation model that online judges use, scaled down to fit one 1 GB server.

**14.1 Run pipeline**

1. The API receives a run request, checks the role, the rate limit and the payload size (source at most 64 KB, stdin at most 64 KB).
2. The request enters the in-process queue (at most 2 running at once, at most 20 waiting, 30-second queue timeout).
3. The runner creates a container from the pre-pulled image for the language, with a temporary in-memory work directory.
4. The source is copied in through the Docker API (never as a shared folder from the host).
5. For C++, a compile step runs first with its own limits (10 seconds, 192 MB); a compile error is returned as the result.
6. The program runs with stdin supplied and stdout and stderr captured, up to the output cap.
7. A watchdog kills the container at the wall-time limit.
8. The runner reads exit status and out-of-memory flag, maps them to a verdict, then force-removes the container.
9. The result is stored briefly and pushed to the room.

**14.2 Limits and flags**

| Control | Value | Docker mechanism |
| --- | --- | --- |
| Wall-clock time | 5 s per run (per-test limit in judging, default 2 s) | Watchdog kills the container |
| Memory | 128 MB, with swap equal to memory so no swap is used | Memory and memory-swap limits |
| CPU | 0.5 of one core | CPU quota |
| Processes | 64 at most (stops fork bombs) | Process-count limit |
| Output | 1 MB at most, then truncated and flagged | Capped by the runner |
| Network | None | Network mode none |
| Filesystem | Read-only root; small writable in-memory work directory | Read-only flag and tmpfs |
| User and privileges | Non-root user, all capabilities dropped, no privilege escalation | User, capability-drop and security options |
| Syscalls | Docker default filter | Default seccomp profile |
| Lifetime | Container removed after every run, with a janitor job removing strays every minute | Remove flag and cleanup job |

**14.3 Judging**

1. Each test runs as its own sandbox run with the test's input.
2. Output is compared after normalizing line endings and trimming trailing whitespace on each line and at the end.
3. The verdict per test is one of: Accepted, Wrong Answer, Time Limit, Memory Limit, Runtime Error, Compile Error, Output Limit, or Internal Error.
4. An Internal Error never counts against the candidate; the interviewer sees it and the run can be retried.
5. The candidate receives counts and verdict categories; the interviewer receives input, expected and actual output.

**14.4 Verdicts to the user**

Every verdict has a plain-language explanation and a hint, for example *Time Limit: your program ran longer than 2 seconds on test 3*.

**14.5 Escape and abuse test suite (must pass before launch)**

| Attack | Expected result |
| --- | --- |
| Infinite loop | Time Limit verdict; container removed |
| Memory allocation bomb | Memory Limit verdict |
| Fork bomb | Stopped by the process limit; host unaffected |
| Huge output printing | Output Limit verdict; server memory stable |
| Network call to the internet or the host | Fails; no connectivity |
| Read of host files or the Docker socket | Not visible; permission denied |
| Writing large files to disk | Fails at the in-memory size limit |
| Many rapid run requests | Rate limited; queue stays bounded |
| Reading another run's data | Impossible; fresh container each time |
| Attempting to start containers from inside | Not possible; no Docker access inside |

**14.6 The main risk and how it is contained**

The runner needs permission to create containers, and that permission is powerful. Containment: run the runner as a separate low-privilege process from the public API where possible, prefer rootless Docker if it is supported on the VM, never expose the Docker socket over a network, never mount it into a sandbox container, and keep the escape suite in the CI pipeline. A stronger sandbox runtime can be evaluated later; it is not assumed for the 1 GB server.

**14.7 Spike before commitment:** a one-day experiment on the real VM measures cold start time per language, memory use, and maximum safe concurrency. If a run takes more than 2 seconds to start, a small pool of pre-started containers is added.

## 15. Security, privacy and abuse prevention

The biggest security risk is running strangers' code on the server, followed by leaking hidden tests, so those two get the strictest controls. The table below is the threat model; each row maps to requirement IDs in sections 6 to 8.

| Threat | Impact | Mitigation | Requirements |
| --- | --- | --- | --- |
| Malicious code escapes the sandbox | Full server compromise | Disposable containers, no network, dropped privileges, limits, escape test suite in CI, runner separated from the API | EX-3, EX-4, SEC-4 |
| Resource exhaustion by runs | Server unresponsive for everyone | Queue cap, concurrency of 2, per-user run rate limit, memory and process limits | EX-6, SEC-1 |
| Candidate extracts hidden tests | Interview integrity lost | Hidden data stays server-side, judged in the sandbox service, only counts returned | INT-5, INT-6 |
| Unauthorized room access | Private code or chat exposed | Unguessable room links, server-checked roles on every channel, expiring sessions | ROOM-1, ROOM-3, AUTH-4 |
| Viewer or candidate edits when not allowed | Tampered code | Read-only enforced on the sync server, not only in the browser | ED-6, INT-7 |
| Stolen session or cross-site request | Account takeover | httpOnly secure same-site cookies, CSRF protection, short idle expiry | AUTH-4, SEC-3 |
| Cross-site scripting through chat or problem text | Script runs in another user's browser | Escape all user content, render Markdown through a sanitizer, strict content security policy | SEC-3 |
| Spam and abuse by guests | Server load, harassment | Rate limits, room owner can remove members, owner can disable accounts, guests cannot create rooms | SEC-1, SEC-7 |
| Brute-forcing room links | Unwanted entry | At least 128 bits of randomness, rate limit on join attempts | ROOM-1, SEC-1 |
| Secrets leaked in code or logs | Credential theft | Secrets only in environment, secret scanning in CI, no source or chat in logs | SEC-5, OBS-1 |
| Vulnerable dependency | Remote exploit | Weekly audit and update checks, pinned lockfile | SEC-6, OPS-3 |
| Data loss | Users lose sessions | Daily backups with a tested restore | OPS-1 |

**Privacy: what is stored and for how long**

| Data | Purpose | Retention |
| --- | --- | --- |
| Name, avatar, email from the login provider | Identity and notifications | Until account deletion |
| Code, chat, run and submission records | The product itself, replay and summaries | Until the room is deleted; rooms idle for 30 days are archived |
| Replay update log | Replay | Compacted after 30 days; removed with the room |
| Event records | Metrics and replay markers | 90 days, then aggregated counts only |
| Server logs | Debugging | 14 days; no source code or chat text |

**Principles:** collect only what the product needs; never sell or share data; show a plain-language terms and privacy page; let users delete everything; tell users that sessions are visible to everyone with the room link.

**Incident handling:** if the sandbox or data is suspected compromised, stop the runner, rotate secrets, restore from the last good backup, and write a short post-incident note. These steps live in the runbook (DOC-5).

## 16. Non-functional requirements

The most important non-functional targets are sync latency under 200 ms, no lost edits, and a best-effort availability of 99% per month on one free server. Targets are goals to verify by measurement, not promises made before measuring.

| Category | Requirement | Target | How it is verified |
| --- | --- | --- | --- |
| Latency | Remote edit visible to a partner | Under 200 ms at the 95th percentile | Timestamped echo test in the load test (section 19) |
| Latency | Page load of the room screen on broadband | Interactive in under 3 seconds on a cold cache | Lighthouse in CI |
| Latency | Run result for a hello-world program | Under 2.5 seconds at the 95th percentile when the queue is empty | Runner spike and load test |
| Throughput | Concurrent rooms on one 1 GB server | 25 rooms (50 connections) in the first target; stretch goal 50 rooms | k6 load test, PERF-1 |
| Correctness | No lost or duplicated edits | 0 divergences in 100 out of 100 randomized concurrent-editing trials | Convergence fuzz test |
| Durability | Data lost on a server crash | At most 2 seconds of edits | Kill-process test during typing |
| Availability | Uptime of the public app | 99% per month, best effort (single server, no redundancy) | External uptime monitor |
| Recovery | Time to restore from backup | Under 1 hour, rehearsed once | Restore drill (OPS-1) |
| Reconnection | Client recovers after a network drop or server restart | Under 10 seconds, with no manual reload | Chaos test in end-to-end suite |
| Security | Web security header grade | A or better | Online header scanner after each release |
| Accessibility | Standard to aim for | WCAG 2.1 level AA on main screens | Automated scan plus a manual keyboard-only pass |
| Browsers | Supported | Latest two versions of Chrome, Edge, Firefox; Safari best effort | Playwright across engines |
| Responsiveness | Screen sizes | Full features from 1024 px width; read-only views down to 360 px | Visual checks |
| Maintainability | Code quality gates | TypeScript strict mode, linting, formatted code, no unreviewed merges | CI pipeline |
| Observability | Time to notice an outage | Under 10 minutes | Uptime monitor interval and alert rules |
| Portability | Move to another host | Redeploy from the repository in under 2 hours | Documented runbook and a dry run |
| Cost | Monthly spend | Zero: free-eligible VM size and free tiers only, with credit alerts at $50 and $80 | Cost Management review weekly |

**Capacity honesty:** one small server cannot be made highly available. The product is designed to fail gracefully (clear messages, automatic reconnect, queued runs) rather than to promise uptime it cannot deliver.

## 17. Resource budget and cost controls

The free-eligible B1s VM has about 1 GB of RAM and 1 CPU core, so every component needs a memory budget and the design uses one Node process plus short-lived sandbox containers. The figures below are approximate planning estimates from general experience, not measurements; the first task on the VM is to measure them with free -m and docker stats and replace these numbers.

**17.1 Planned memory budget (approximate, MB)**

| Component | Planned share | Notes |
| --- | --- | --- |
| Operating system and background services | 200 | Minimal Linux image, no desktop services |
| Docker engine | 100 | Idle daemon |
| Node process (API, sync, room events) | 200 | One process; heap capped with a Node memory flag |
| Caddy (HTTPS proxy) | 30 | Small static footprint |
| Active sandbox runs | 256 | Two runs at 128 MB each; a C++ compile uses up to 192 MB and counts as one run slot |
| Headroom and file cache | about 214 | Never planned away; protects against out-of-memory kills |
| **Total** | **about 1,000** | A 2 GB swap file is added as a safety net, never relied on |

**17.2 Design consequences**

1. One Node process only; no Redis, no separate worker process in the first version.
2. Concurrency of sandbox runs is capped at 2, and C++ compiles are serialized.
3. The Node heap is capped, and the process restarts automatically if it exceeds its limit.
4. If measured idle memory is far above plan, the fallback is to merge the sync server into the API process (already planned) and, as a last resort, reduce the room cap.
5. If the VM proves too small in the load test, the choice is to upgrade to a larger size using student credit for the busy months (a deliberate, budgeted decision), or reduce the load target.

**17.3 Student credit and cost controls**

| Control | Detail |
| --- | --- |
| Credit | $100 for 12 months, expiring 2027-10-14 on the portal shown at activation; renewal is possible while enrolled |
| VM choice | A Linux VM size on the free-services list (B1s), created from the portal's free-services page, with the free-eligible disk size |
| First-day check | After the VM is created, open Cost Analysis after 24 hours and confirm the VM shows no charge; if it does, resize or delete at once |
| Budget alerts | Annual budget of $100 with alerts at 50% and 80% of spend, sent to an inbox read daily |
| Weekly review | Check Cost Management once a week during development and monitoring after launch |
| Other billable items | Check that the public IP, disks, backups storage and outbound data stay inside free allowances; confirm each before creating it |
| No upgrade | Do not upgrade to pay-as-you-go; when credit ends, either renew or move to the portable fallback |
| Exit plan | Everything runs from Docker Compose, so the same stack can be redeployed on another host in under 2 hours (section 16) |

## 18. Hosting, deployment and CI/CD

The frontend is deployed to free static hosting, the backend runs on one Azure VM through Docker Compose, and every merge to the main branch is built, tested and deployed by GitHub Actions. Deployment is set up in week 1, before features, so that the product is always deployable.

**18.1 Environments**

| Environment | Where | Purpose |
| --- | --- | --- |
| Local | Developer laptop with Docker Compose | Daily development; same containers as production |
| CI | GitHub Actions runners | Lint, tests, sandbox escape suite, end-to-end tests, build |
| Preview (frontend only) | Static host preview for each pull request | Review UI changes before merge |
| Production | Azure VM plus static host | Real users; no separate staging server because 1 GB of RAM cannot hold two stacks |

**18.2 Production topology**

1. The browser loads the static frontend from the static host over HTTPS.
2. The frontend calls the API and opens WebSockets to the VM at one HTTPS hostname.
3. Caddy on the VM terminates TLS (certificates renew automatically) and forwards to the Node container.
4. The Node container talks to the managed database over TLS and to the Docker engine through a restricted path to create sandbox containers.
5. Backups are written daily to cloud object storage.

All WebSocket traffic uses secure WebSockets on port 443, which passes through most campus and corporate firewalls. A free hostname is needed for the VM; the cloud provider's DNS name for a public IP is the first option (to verify), with a free dynamic DNS name as the fallback, since buying a domain is not required.

**18.3 CI/CD pipeline**

1. A pull request triggers lint, type check, unit and integration tests, the problem-bank reference validation, and a secret scan.
2. The sandbox escape suite and the two-browser end-to-end test run against containers built in CI.
3. Merging to main builds the backend image, tags it with the commit hash, and pushes it to the container registry.
4. The pipeline connects to the VM over SSH with a restricted key, pulls the new image and restarts the stack.
5. A health check runs; on failure the pipeline restores the previous image tag and fails the build.
6. The frontend deploys to the static host in parallel, with the API address set per environment.

**18.4 Configuration and secrets**

- All configuration comes from environment variables; a committed example file lists every variable with no real values.
- Real secrets live in the CI secret store and in a protected file on the VM, never in the repository or an image.
- OAuth callback addresses are set per environment.

**18.5 One-time setup checklist**

- [ ] Create the Azure VM from the free-services page and check Cost Analysis after 24 hours
- [ ] Add a 2 GB swap file and cap the Node heap
- [ ] Install Docker, pull the three language images, and run the sandbox spike (14.7)
- [ ] Create the database project and confirm its free size limit and connection rules
- [ ] Register OAuth apps for Google and GitHub for local and production addresses
- [ ] Create accounts for the static host, error tracking and uptime monitoring, and note their current free limits
- [ ] Create the GitHub repository with branch protection and Actions secrets
- [ ] Schedule the daily backup job and rehearse a restore

**18.6 Rollback and restart:** every image is tagged by commit; rollback is a single command that redeploys the previous tag. The server handles termination signals by flushing pending document updates before exit (OPS-2).

## 19. Testing strategy

Testing is organized by risk: the riskiest parts (sandbox, roles, hidden tests, convergence) get the most automated checks, and every number in the product claims is produced by a repeatable test.

| Test type | Tools | What it checks | When it runs | Pass condition |
| --- | --- | --- | --- | --- |
| Unit | Vitest | Role rules, timer maths, verdict mapping, output normalization, rate limiter, input schemas | Every pull request | 70% line coverage overall; above 90% on roles and judging |
| Integration | Vitest and Supertest with a real database | REST endpoints, authorization on every route, room lifecycle, scorecard and share links | Every pull request | All pass; no route lacks an authorization test |
| Sandbox escape | Scripted attack programs | The ten attacks in section 14.5 | Every pull request and before each deploy | Every attack ends in the expected safe verdict |
| Convergence fuzz | Randomized concurrent edits over two or three simulated clients | Identical final text on all clients | Nightly and before release | 0 divergences in 100 of 100 trials |
| Replay exactness | Automated comparison | Final replay frame equals saved document | Every pull request | Byte-identical |
| End to end | Playwright with two browser contexts | Full interview journey J1, reconnect journey J3, role change, hidden test confidentiality | Every merge to main | All pass; includes a check that hidden tests never appear in candidate network traffic |
| Security scan | Dependency audit, secret scanner, header scanner | Vulnerable packages, leaked secrets, missing headers | Every pull request and weekly | No critical findings |
| Accessibility | Automated scan plus a manual keyboard pass | Main screens | Before each release | No critical violations |
| Load | k6 with WebSocket scripts | 25 rooms, 50 connections, 10 minutes of continuous typing, then chat and runs | Before launch and after major changes | 95th-percentile sync latency under 200 ms, error rate under 1% |
| Soak | k6 | 10 rooms for 2 hours | Once before launch | Memory growth under 10%, no crash |
| Chaos and recovery | Scripts | Kill the server during typing; drop the network on one client; restart the VM | Before launch | At most 2 seconds of edits lost; clients reconnect within 10 seconds |
| Backup restore | Manual drill | Restore yesterday's backup into a fresh database | Once, then quarterly | Data intact; under 1 hour |
| Authorship attribution | Vitest with simulated clients | Three clients each type a separate block; every block is attributed to the right author; a forged client ID is rejected; per-author shares match a reference calculation | Every pull request | 100% correct attribution |
| Idempotency and duplicate delivery | Vitest and Supertest | The same REST request with one idempotency key creates one record; the same Yjs update applied twice changes nothing; double-clicking Submit judges once | Every pull request | Exactly one record or judging job; identical document text |
| Live change indicators | Playwright with two browser contexts | A remote edit is highlighted in the author's color within 200 ms and clears; the typing indicator appears and disappears on time; the local caret stays on the same text while a remote client inserts lines above it | Every merge to main | All checks pass; caret never moves |
| Appearance settings | Playwright with two browser contexts | Every theme and font applies; text size changes keep cursors aligned; two browsers with different settings stay independent; settings persist after a reload | Every merge to main | All checks pass; theme switch under 100 ms |

**How sync latency is measured honestly:** a test client sends an edit carrying a send timestamp; a second client on a separate machine records receive time, with both clocks aligned by a round-trip estimate. The load test reports median, 95th and 99th percentile, the machine used, and the connection type, and the results file is committed to the repository.

**Test data:** a fixed seed set of users, rooms and the 8 bank problems is created by a script, so every test run starts from the same state.

**Release checklist (all must be true):** CI green, escape suite green, load test within targets and saved, backup restore drilled, header scan A or better, error tracking receiving a test event, uptime monitor receiving checks, and the runbook reviewed.

## 20. Observability and metrics

Every number used on a resume or in an interview must come from logged data or a saved test result; invented or estimated figures are never published. Metrics fall into product metrics, which show whether people use it, and engineering metrics, which show whether it works.

**20.1 Product metrics (owner metrics page, MET-1)**

| Metric | Definition | Source |
| --- | --- | --- |
| Registered users | Distinct signed-in accounts created | users collection |
| Guest participants | Distinct guest identities that joined a room | guests collection |
| Rooms created | Count by type (practice or interview) per day | rooms collection |
| Completed interviews | Interview rooms that reached Ended with a scorecard saved | rooms and scorecards |
| Weekly active users | Distinct users who joined a room in the last 7 days | events collection |
| Return rate | Share of users who join a room again within 7 days of their first | events collection |
| Session length | Median time from Start to End for interview rooms | rooms collection |
| Feature use | Share of sessions that used run, submit, replay, follow mode | events collection |

**20.2 Engineering metrics**

| Metric | Definition | Target | Source |
| --- | --- | --- | --- |
| Sync latency | Time for an edit to reach a second client; median and 95th percentile | 95th under 200 ms | Load test and sampled live pings |
| Run duration | Time from request to result; 95th percentile | Under 2.5 s when idle | Runner timings |
| Queue wait | Time a run waits for a slot; 95th percentile | Under 3 s | Queue timings |
| Run success rate | Runs that end in a user-caused verdict or success, not an internal error | Above 99% | Verdict counts |
| Error rate | Server errors per 1,000 requests | Under 1% | Logs and error tracking |
| Uptime | Share of monitor checks that pass in a month | At least 99% | Uptime monitor |
| Memory and CPU | Server resource use over time | Memory under 85% sustained | Runtime metrics |
| Deploy frequency and failures | Merges deployed, rollbacks | Rollbacks rare | CI history |
| Test health | Coverage and pass rate | At least 70% coverage; 100% pass on main | CI |

**20.3 Logging, alerts and dashboards**

1. Logs are JSON with a request ID, hashed user ID and room ID; code and chat text are never logged.
2. Error tracking groups errors by release and sends an email on a new error type.
3. The uptime monitor checks the health endpoint every 5 minutes and emails after 2 consecutive failures.
4. Alerts also fire when memory stays above 85% for 10 minutes, when the queue is full, or when the daily backup fails.
5. The owner metrics page shows 7-day and 30-day views with the numbers above; there is no complicated dashboard system.

**20.4 Event tracking rules:** record only events listed in the data model; no third-party analytics scripts; counts are aggregated after 90 days; a user who deletes an account has their events removed.

## 21. UX and UI requirements

The interface has 11 screens, and the room screen is the one that decides whether the product feels professional. Design principle: a candidate under stress should never wonder what to do next, and an interviewer should see everything they need without hunting.

**21.1 Screens**

| Screen | Purpose | Key elements | Required states |
| --- | --- | --- | --- |
| Landing | Explain the product and start | One-line pitch, *Start a room* button, short feature summary, sign-in | Signed out, signed in |
| Sign in | Authenticate | Google and GitHub buttons, guest note | Loading, failed, cancelled |
| Dashboard | List my rooms | Room cards (name, type, status, date), *New room*, filter by type | Empty, loading, error |
| Create room | Configure | Type choice, language, problem picker, time limit, create | Validation errors, saving |
| Lobby | Wait for the session | Role, participants, Ready toggle, problem preview, share link copy button | Waiting, ready, full room |
| Room | Do the interview or practice | Top bar (timer, role, connection status, end button), problem panel, editor, participants and chat panel, console with run and submit | Connected, offline, reconnecting, locked, ended, run in progress, queued |
| Summary | Review a finished session | Final code, test results, scores, comments, share and export buttons | Candidate view, interviewer view, shared view, revoked link |
| Replay | Watch the session | Read-only editor, scrubber with event markers, speed control | Loading, playing, paused, finished |
| Scorecard | Rate the candidate | Four 1 to 5 criteria, comment box, autosave note | Draft, saved |
| Owner metrics | Check health | Product and engineering charts for 7 and 30 days | Loading, no data |
| Not found and error | Recover | Plain message, a way back to the dashboard | Not found, forbidden, server error |

**21.2 Room screen layout**

1. A top bar shows the timer, the user's role, a connection indicator and, for the interviewer, Start and End buttons.
2. A left panel shows the problem statement and sample cases and can be collapsed.
3. The center holds the editor, with each remote cursor colored and labelled with a name; a Show authors toggle tints each person's text in their color.
4. A right panel shows who is present and the chat, with unread count when collapsed.
5. A bottom console has Run, a custom-input box, and output tabs for stdout, stderr and test results; the interviewer also gets a per-test table.
6. On narrow screens the panels become tabs, and the editor stays the main view.

**21.3 Interaction rules**

- Every action gives feedback within 100 ms (a spinner, a disabled button, or a toast).
- Destructive actions (end session, delete room, remove member) ask for confirmation.
- Connection loss is shown clearly and never silently drops work; the editor stays editable offline.
- Locked states (before start, after end, viewer) say why the editor is read-only.
- The candidate never sees controls that belong to the interviewer.
- Keyboard shortcuts: run (Ctrl or Cmd plus Enter), toggle panels, focus chat; a shortcut list is available from a help icon.

**21.4 Visual and accessibility rules**

- At least 8 themes, with the editor and the app interface matching (section 6.8).
- Text contrast meets WCAG 2.1 level AA; focus outlines are always visible; every control is reachable by keyboard.
- Cursor colors are chosen from a color-blind-safe palette and always paired with a name label, never color alone.
- Run verdicts use an icon and a word as well as a color.
- Respect the system setting for reduced motion; no flashing animations.
- Plain, friendly microcopy, written for students under time pressure.

## 22. Timeline and milestones

The plan runs six weeks from a Monday start and ends with the Phase 3 gate and the public launch; it assumes about 125 to 170 hours at 3 to 4 hours a day, which is tight for 123 requirements, so the order of work matters more than the dates.

&#91;embedded content: six-week plan · 6 weekly blocks, 3 phase gates\]

Bars are weekly work blocks and diamonds are the phase gates from section 4; the highlighted diamond is the launch gate. If more weeks are available, the extra time goes into week 6 and into a buffer before it.

| Week | Deliverables | Definition of done |
| --- | --- | --- |
| 1 Foundation | Repository, CI skeleton, Azure VM with Docker, swap and HTTPS, deploy pipeline with a health endpoint, OAuth apps registered, sandbox spike, memory baseline | A push to main deploys to the public URL; the spike report and memory baseline are written |
| 2 Editor and rooms | AUTH-1 to 5, ROOM-1 to 6, Monaco with Yjs sync, cursors, document persistence (PER-1), CONC-1 to 4, LIVE-1 to 8, UIX-1 to 7 and UIX-13 | Two browsers edit one room live on the deployed URL; roles are enforced by the server |
| 3 Run code and chat | EX-1 to 7, CH-1 to 3, PER-2 and 3, UI states, UIX-8 to 12 | Phase 1 gate: two people complete a full session on the live URL; first testers invited |
| 4 Interview mode | INT-1 to 8, PB-1 to 4 with 8 problems validated in CI | An interviewer runs a timed session with hidden tests; the network check proves tests stay hidden |
| 5 Replay and scorecard | RP-1 to 6, SC-1 to 5, FM-1 to 3, ATTR-1 to 8 | Phase 2 gate: a full mock interview works end to end; the replay exactness test passes |
| 6 Harden and launch | Finish SEC, QA, PERF, OBS, MET, DOC and OPS items; load, soak and restore tests; release checklist | Phase 3 gate: load test saved and within targets; every item in the release checklist (section 19) is true |

**Hardening starts early:** CI, structured logging, rate-limit middleware and the escape test suite begin in weeks 1 to 3; week 6 finishes and proves them rather than starting them.

**If time runs short, defer in this order:** UIX-8 to 10, FM-1 to 3, SC-5, PB-4, RP-6, then the remaining P1 requirements. P0 requirements, the escape suite and the load test are never deferred.

**Weekly rhythm:** Monday plan the week's requirement IDs; Friday run the full test suite, deploy, check Cost Analysis and the metrics page, and write three lines of progress notes for the decisions log.

## 23. Risks, mitigations and fallbacks

The three risks most likely to hurt the project are the 1 GB memory limit, the sandbox turning out harder or less safe than planned, and a solo builder running out of time. Likelihood and impact are judgments (low, medium, high) to be revised as facts arrive.

| # | Risk | Likelihood | Impact | Mitigation | Fallback |
| --- | --- | --- | --- | --- | --- |
| R1 | The 1 GB VM runs out of memory under load | High | High | Memory budget (17), heap cap, run concurrency of 2, swap file, early measurement | Reduce room cap; merge services; upgrade size with credit for peak months |
| R2 | Sandbox escape or abuse | Low to medium | Very high | Disposable containers, no network, dropped privileges, escape suite in CI, runner isolation | Disable execution and keep editing and chat running; restrict to browser-side JavaScript |
| R3 | Custom runner takes too long to build or is unreliable | Medium | High | One-day spike in week 1; keep a provider interface | Use a lighter existing engine, or hosted execution with strict limits |
| R4 | Solo scope is too large for the time available | High | High | Strict phase gates; the MVP is always deployed; weekly review of remaining work | Defer follow mode, SC-5, PB-4 and RP-6 first; Phase 4 is already optional |
| R5 | Azure student credit or free VM terms change, or verification is revoked | Low to medium | High | Weekly cost review; portable Docker Compose; backups off the VM | Redeploy elsewhere within 2 hours; use serverless frontend plus hosted execution for a reduced version |
| R6 | Free database tier fills up (update logs grow fast) | Medium | Medium | Compaction, size measurement in the first load test, snapshot cadence | Shorten replay retention; archive old rooms |
| R7 | Hidden tests leak to candidates | Low | High | Server-only storage and judging; network inspection in end-to-end test | Rotate tests; limit tests to server-generated variants |
| R8 | Campus networks block WebSockets or the VM address | Medium | Medium | Secure WebSockets on port 443; automatic fallback transport in Socket.IO | Long-polling mode for the room events channel |
| R9 | Spam or abuse from public links | Medium | Medium | Rate limits, guests cannot create rooms, owner can remove members, account disable | Temporarily require sign-in to join |
| R10 | Single server outage during a demo or interview week | Medium | Medium | Uptime alerts, rollback command, runbook, avoid deploys in important weeks | A recorded demo and the load-test report as proof of work |
| R11 | OAuth setup or app review delays | Low | Medium | Register OAuth apps in week 1 | Temporary email link login |
| R12 | Problem content has licensing issues | Medium | Medium | Write original problems or use clearly licensed ones | Reduce the bank to the problems already cleared |
| R13 | Free-tier terms differ from what this document assumes | Medium | Medium | Verify each free tier on the day of signup (18.5) | Swap provider; the architecture does not depend on any single vendor |
| R14 | Not enough real users to make metrics meaningful | Medium | Medium | Launch to classmates by the end of Phase 2; ask each tester to bring one partner | Report load-test numbers alongside real usage, labelled separately |

## 24. Open questions, assumptions and decisions log

Thirteen decisions are tracked here; four are agreed and the rest need a quick yes or a spike result before the build starts. Change a status with the dropdown as decisions are made.

| # | Decision or question | Recommendation | Status |
| --- | --- | --- | --- |
| 1 | Product positioning | Placement-prep and mock-interview platform (option A) | Agreed |
| 2 | Scope | Phases 1 to 3 in full, nothing cut; Phase 4 (video, AI hints) only if time remains | Agreed |
| 3 | Backend hosting | Azure student credit, free-eligible Linux VM, Docker Compose; no payment card used | Agreed |
| 4 | Sandbox model | Disposable Docker container per run with fixed limits | Agreed |
| 5 | Database | MongoDB Atlas free tier (builder's strength); PostgreSQL is the alternative | Proposed |
| 6 | Room events channel | Socket.IO next to the Yjs sync server | Proposed |
| 7 | Redis | Not in version 1; add only if more than one server process is needed | Proposed |
| 8 | Execution engine | Own runner, confirmed by the week 1 spike; Judge0 if the spike fails | Proposed |
| 9 | Editor | Monaco | Proposed |
| 10 | Languages | Python, C++ and JavaScript | Proposed |
| 11 | Guests | May join by link and run code, cannot create rooms | Proposed |
| 12 | Problem bank | Write 8 original problems rather than copying from other platforms | Proposed |
| 13 | Timeline | Planned as 6 weeks at 3 to 4 hours a day (about 125 to 170 hours); the exact time available has not been given | Open |

**Open questions for the builder**

- [ ] How many weeks, exactly, are available? The plan in section 22 assumes 6 and can be compressed or stretched.
- [ ] Is the name PairPrep acceptable, or is there a preferred name?
- [ ] Is a public GitHub repository acceptable? (Free CI and free container registry assume it.)
- [ ] Who are the first ten testers, and when can they be available?

**Assumptions to verify**

1. The B1s Linux VM is free under the student offer when created from the free-services page.
2. The database free tier needs no payment card and its storage cap is large enough after compaction.
3. The static host, error tracking and uptime monitor free tiers cover the expected use.
4. A free hostname for the VM is available without buying a domain.
5. A single small VM can run the sandbox with acceptable start-up time.

## 25. Success metrics and the resume and interview narrative

The project succeeds if it is live, used by real people, and backed by measured numbers the builder can defend. The targets below are proposed goals, to be adjusted after the first load test and the first week of real use.

**25.1 Success targets (proposed)**

| Area | Target | Evidence |
| --- | --- | --- |
| Availability | Public HTTPS URL live for at least 60 days before placement season | Uptime monitor history |
| Real users | At least 50 registered or guest users | Owner metrics page |
| Real usage | At least 100 completed sessions, of which at least 30 interview-mode sessions with a scorecard | Owner metrics page |
| Latency | 95th-percentile sync latency under 200 ms in the load test | Saved load-test report |
| Scale | 25 concurrent rooms (50 connections) at under 1% errors | Saved load-test report |
| Safety | All ten sandbox attacks end in the expected safe verdict | Escape suite in CI |
| Quality | At least 70% test coverage and an always-green main branch | CI badge and report |
| Documentation | README, architecture diagram and 6 decision records | Repository |

**25.2 Resume bullets (fill with real measured numbers only)**

- Built a real-time collaborative interview platform using Yjs CRDT conflict resolution, serving \[N\] users across \[M\] sessions with \[X\] ms 95th-percentile sync latency.
- Designed a sandboxed code-execution service running each submission in an isolated Docker container with memory, CPU, time and network limits, judged against hidden test cases.
- Shipped to production at zero hosting cost with CI/CD, automated end-to-end tests, error tracking and uptime monitoring; validated by a load test of \[K\] concurrent rooms.

The bracketed values stay empty until the metrics page and test reports provide them.

**25.3 Interview questions this project prepares for, and the points to make**

| Likely question | Points to make |
| --- | --- |
| Why CRDT and not operational transformation? | Edits merge without a central ordering server, which allows offline editing and a replayable history; the cost is larger state and metadata, handled by compaction |
| How do you stop malicious code on your server? | Defense in depth: disposable containers, no network, dropped privileges, limits on memory, processes and output, runner separation, and an attack suite in CI |
| How do you keep hidden tests hidden? | They never leave the server; the candidate's browser receives counts only; an end-to-end test inspects network traffic to prove it |
| How did you handle a 1 GB server? | Budgeted memory per component, capped concurrency and heap, measured before and after, and documented what to change if load grows |
| What happens when a user loses connection? | Local edits continue, the client reconnects, state vectors exchange only missing updates, and nothing is lost |
| How would you scale this beyond one server? | Add Redis for shared queue and rate limits, run multiple sync nodes with room affinity, move runners to a separate pool, use a managed database |
| What would you do differently with more time or money? | Stronger sandbox runtime, multi-region, managed monitoring, video and AI hints |
| How did you decide what to cut? | Phase gates, the always-deployable MVP, and a written decisions log |

**25.4 Honest-claims rule:** a claim is only used if a log, test report or monitor produced it; load-test numbers and real-user numbers are always labelled separately.

## 26. Glossary

Plain-language definitions of the terms used in this document.

| Term | Meaning |
| --- | --- |
| CRDT | Conflict-free replicated data type: a data structure that lets many people edit their own copy and merge automatically with no lost edits |
| Operational transformation (OT) | An older approach to shared editing that relies on a central server to reorder conflicting edits |
| Yjs | A JavaScript library that implements CRDTs for text and other shared data |
| Awareness | Yjs feature for temporary information such as cursor position, name and color; not saved |
| Hocuspocus | A server that carries Yjs updates over WebSockets, with hooks for login and saving |
| WebSocket | A long-lived two-way connection between browser and server for instant updates |
| Socket.IO | A library built on WebSockets with rooms, automatic reconnection and acknowledgements |
| Monaco | The code editor component used in VS Code |
| Sandbox | A restricted environment where untrusted code can run without harming the host |
| Docker container | A lightweight isolated environment started from an image; here one is created and destroyed per run |
| Seccomp | A Linux feature that blocks dangerous system calls |
| Verdict | The outcome of a run, for example Accepted, Wrong Answer or Time Limit |
| Hidden test | A test case whose input and expected output only the interviewer and server can see |
| Replay | Playback of how the code changed over time, built from the timestamped update log |
| Compaction | Merging many old small updates into one snapshot to save storage |
| Rate limiting | Capping how often one user or address can perform an action |
| P0 and P1 | Priority labels: P0 must ship in its phase, P1 should ship |
| 95th percentile (p95) | The value that 95% of measurements are at or below; shows typical worst case |
| CI/CD | Continuous integration and delivery: automatic testing and deployment on every change |
| B1s | A small, low-cost Azure VM size with about 1 vCPU and 1 GB of RAM, on the student free-services list |
| Health check | A URL the monitor calls to confirm the app and its dependencies are working |
| Runbook | A short written procedure for operating the system and handling incidents |
