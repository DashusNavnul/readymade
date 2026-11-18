# What your ship can tell you

Your ship keeps its own record of what is running, what is waiting on you and what it told
your collaborators. Readymade reads those pages and shows them as plain screens. Each screen
states what the ship answered when you opened it; press **Read again** to ask again. When the
ship refuses something, the screen shows the ship's own reason.

Every command below is in the Command Palette under **Readymade:**, and most are in the
**Ship** group of the Readymade sidebar. The owner's screens need the full Pataphor backend.
A ship with only the small collaboration service has the screens under **If you collaborate**.

## If you own the project

| Command | What it shows |
|---|---|
| **Overview** | What is running, what changed in the last day, what is blocked, which decisions wait on you, and what happens next. The status bar shows how many decisions are waiting. |
| **Tasks and Questions from Agents** | Which agent holds which task and until when, the tasks agents proposed, and the questions agents left for you. A question blocks only its own task until you answer it, or until the agent that asked withdraws it. An answer cannot be changed afterwards. **Dismiss** sets a proposal aside; it stays in the record, marked as dismissed or withdrawn. |
| **Notices Sent and Received** | Everything your ship told collaborators, each marked pending, delivered, refused or unknown. Unknown means your ship restarted before their ship confirmed. It is never sent again by itself; **Send it again** appears only on an unknown notice. A ship keeps at most 512 notices and records none after that; the screen says when the store is nearly or completely full. |
| **Suggestion History for This Project** | Each suggestion with its four steps: who wrote it, its review, whether it landed, and whether its author's ship acknowledged being told. |
| **Work Requests** | Work collaborators asked your ship's agents to do, and work your ship asked of others. A request is taken only while your standing policy is in force, from a contributor, for a session you shared with them. **Dismiss** removes one that has not started; its requester is told. |
| **Session Roles for This Project** | For each shared session: who controls it, who asked for work in it, and who may only watch. |
| **Standing Policy** | What your agents may do without asking: objectives, files, tools, resources and when to ask you. Every version is kept. Changing or revoking it asks you first. |
| **Memory Handoff for a New Model** | A document of your ship's memory, bounded in size, for a new or returning model: what changed since that model's last turn, the open questions, and the current context. Each memory says what it is: a ruling, a fact, a hypothesis, an open question, or unlabelled. |
| **Label or Replace a Memory** | Say what one memory is, or record that a newer memory replaces it. Both stay readable. A replacement recorded by mistake can be taken back. |

## If you collaborate on someone else's project

| Command | What it does |
|---|---|
| **Read New Notices from Owners** | Readymade does this by itself each time it connects. Shows, once, what owners told your ship since you last looked: your suggestion landed, or your work request was queued, started or finished. **Check What Is Waiting on Me** and **Catch Me Up** include these too. |
| **Follow a Shared Session Live** | Shows a shared session's status in the status bar as it changes. If you follow the same session again later, it continues from where you left off. The owner's ship checks your access each time; if the owner stops sharing, the stream ends and says why. |
| **Ask the Owner's Agent for Work** | Sends one instruction for a session shared with you. The owner's policy decides. You are told whether it was queued or refused, and why. It is never sent twice. **Work Requests** keeps what you asked from this ship on this computer, with where each request stands: queued, started, finished, or refused. **Withdraw** takes back a request the owner has queued but not started. |
| **Who Has What Open** | Lists who is viewing, editing or has an agent on each shared file of the project in front of you, as the owner's ship shows it. Owners can use it too. |
| **Show or Stop Showing Which Shared File I Have Open** | Off until you turn it on. While on, the project's owner and the collaborators who can see that file see that you are viewing or editing it. Only files already shared with you are reported, and each report expires after a few minutes. |

To follow a session or ask for work, first open the shared project and refresh its shared
sessions, so Readymade knows which sessions are shared with you.

## What these screens never do

- They never send a command twice. If the ship does not answer in time, the screen says the
  outcome is unknown and asks you to read the page again.
- They never guess. A page your ship does not have is reported as missing, and a part of a
  page the ship could not read is named as unavailable instead of being shown as empty.
- They never change anything by reading.
- They never show one ship's page as another's. When you connect a different ship, every open
  screen is read again from that ship, and each confirmation names the ship it will change.
  What Readymade remembers on this computer (notices already shown, requests you asked, where a
  followed session left off) is kept separately for each ship.
