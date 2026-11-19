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
| **Tasks and Questions from Agents** | Which agent holds which task and until when, the tasks agents proposed, and the questions agents left for you. A question blocks only its own task until you answer it, or until the agent that asked withdraws it. An answer cannot be changed afterwards. **Dismiss** sets a proposal aside; it stays in the record, marked as dismissed or withdrawn. A ship keeps a few hundred proposals and a few hundred claim records per task: the longest-closed proposals and the oldest claim records are dropped to make room, and an open proposal never is. |
| **Notices Sent and Received** | Everything your ship told collaborators, each marked pending, delivered, refused or unknown. Unknown means your ship restarted before their ship confirmed. It is never sent again by itself; **Send it again** appears only on an unknown notice. A ship keeps a few hundred notices in each direction. When that many are held, sent notices that were answered, or went unanswered for thirty days, are dropped first, oldest first; received notices are dropped from whichever sender holds the most. A ship with an older backend stops recording at 512, and the screen says when that is near. |
| **Suggestion History for This Project** | Each suggestion with its four steps: who wrote it, its review, whether it landed, and whether its author's ship acknowledged being told. If the ship's archive is longer than it reads at once, the screen says that some suggestions may be missing. |
| **Work Requests** | Work collaborators asked your ship's agents to do, and work your ship asked of others. A request is taken only while your standing policy is in force, from a contributor, for a session you shared with them, and not for a session your ship knows it would refuse to run. A session opened before the project's setup last changed still lists as paused or ready, but your ship refuses every run of it while the setup stays changed. When your ship can tell that a session is in that state, a request for it is refused, a request already waiting for it is ended as not started, and the sharing screen marks it **cannot run**. Open a new session and share that one. A shared session that sits in judgment (as one does after it has answered) takes the next waiting request once it has written nothing for ten minutes and no completion review of it is unfinished. That holds for any shared session in judgment, including one you are working in yourself. **Dismiss** removes one that has not started; its requester is told. A request that was given to its session says where it stands, read from the session's own record: **Running now** only when a run of that instruction began and the session is in a model turn or a tool call; **Held, not running** when the session took the instruction and no run began; **Ran** when a run began and the session has gone quiet. A ship with an older backend says only when it was given to the session. With no standing policy in force the screen says so, since every request is then refused. A request the session did not take, or set aside because a review is unsettled, is ended as not started and its requester is told, so it does not hold a place in the queue. One the session took stays until the session has stopped; if it then never ran, or ran and stopped part-way, the screen and the requester's notice say so, and the requester is not told again if you run it later. A waiting request can start a session that is paused, since a session that was opened and not yet run is paused too, and one that has rested in judgment; to hold a session, dismiss its waiting requests or stop sharing it. |
| **Session Roles for This Project** | For each shared session: who controls it, who asked for work in it, and who may only watch. |
| **Standing Policy** | What your agents may do without asking: objectives, files, tools, resources and when to ask you. Every version is kept. Changing or revoking it asks you first. |
| **Memory Handoff for a New Model** | A document of your ship's memory, bounded in size, for a new or returning model: what changed since that model's last turn, the open questions, and the current context. Each memory says what it is: a ruling, a fact, a hypothesis, an open question, or unlabelled. |
| **Label or Replace a Memory** | Say what one memory is, or record that a newer memory replaces it. Both stay readable. A replacement recorded by mistake can be taken back. |

## If you collaborate on someone else's project

| Command | What it does |
|---|---|
| **Read New Notices from Owners** | Readymade does this by itself each time it connects. Shows, once, what owners told your ship since you last looked: your suggestion landed, or your work request was queued, given to its session, or ended. **Check What Is Waiting on Me** and **Catch Me Up** include these too. |
| **Follow a Shared Session Live** | Shows a shared session's status in the status bar as it changes. If you follow the same session again later, it continues from where you left off. The owner's ship checks your access each time; if the owner stops sharing, the stream ends and says why. |
| **Ask the Owner's Agent for Work** | Sends one instruction for a session shared with you. The owner's policy decides. You are told whether it was queued or refused, and why. It is never sent twice. After it is given to the session, you are told how it ended once the session has stopped; the owner's ship waits ten minutes after the session's last step before it calls a quiet session stopped, so the ending can arrive ten minutes or so after the work itself. A request for a session that cannot run is refused at once, and says so. **Work Requests** keeps what you asked from this ship on this computer, with where each request stands: queued, given to its session, ended (with how), or refused. **Withdraw** takes back a request the owner has queued but not started. |
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
