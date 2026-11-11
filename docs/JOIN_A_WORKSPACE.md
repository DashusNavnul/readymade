# Join a Readymade workspace

To work with [DashusNavnul](https://github.com/DashusNavnul), start by setting up
Readymade on your own computer and connecting your own Urbit. Each participant
keeps their own ship login private. A collaborator's access code is not an
invitation and is never needed for joining a group.

## What you can set up from this repository

Download the `.dmg` from the [Apple Silicon meeting preview](https://github.com/DashusNavnul/readymade/releases/tag/v0.2.0-alpha.20261110.1),
drag Readymade Workspace to Applications and open it. See [LLM setup](LLM_SETUP.md)
for first-launch help or an optional source build; the download needs no development tools.
Choose **Home → Connect your Urbit**, authenticate privately, then open Groups, Glurff,
Calls or Landscape if those apps are already installed on your ship. In a new
Readymade terminal, `groups` opens Tlon Groups and `landscape` opens the app
launcher. Both reveal retained tabs without reloading them.

Current source supports verified local discovery for real galaxies, stars,
planets, moons and comets, with another identity check before sign-in. The linked
preview lists local planets only; use **Enter a ship’s web address** for other
classes or hosted ships. Automated discovery and login tests do not qualify live
acceptance for every class or a first backend installation on your own ship.

Tlon's first synchronization in a fresh tab can take several minutes. Wait for
the actual interface to appear; successful authentication alone is not enough.

## Coordinate with the host

Get the intended group/channel invitation from DashusNavnul or your workspace
host. This repository does not contain a universal group invitation, public
coding endpoint or automatic project grant. Do not guess those details from
examples or development paths.

Use the invitation in Tlon Groups while signed into your own ship. Confirm with
the host that you have joined the intended group. Exchange messages or join a
call only when you choose to do so. The assistant should not send messages or
start calls merely to complete installation.

Groups provides the communication surface. Joining a group does not itself
grant access to a coding project, another participant's files or model budget.
You can use your local editor and coding assistant while coordinating in the
installed apps; that is separate from Readymade's shared execution features.

## Shared coding execution still needs a compatible backend

The public repository ships the desktop and bounded
[native backend installation tools](../backend/install/README.md). Installation
requires separate owner authorization, actual native access to the receiving
ship, and the source, compilation, preservation and HTTP checks in that guide.
A web login alone does not provide native installation access. Full self-service
release and independent two-person coding acceptance remain open; this joining
guide alone does not establish them.

For shared coding execution, the host establishes the actual project, coding
session, permitted actions, compatible backend and model/provider connection.
A guest needs the collaboration protocols and grants for joining or viewing
shared files, but does not need their own Viki session or provider merely to
join. Running coding work on the guest's own ship requires that ship's separate
execution setup. See [compatibility](COMPATIBILITY.md). Do not substitute the
host's owner login or forward its credentials.

Inspect the project/session and shared request catalog before submitting work.
If the required backend is absent, stop that part of setup and report the missing
requirement. Keep working local editor and app access available. Do not install
unverified ship agents or manufacture grants to make a demo appear connected.

Before describing a session as working shared execution, verify that both real
participants can observe the intended project/request and that one deliberately
authorized, bounded coding request produces the correlated result. Distinguish
request recording, execution, review and deployment. A local fixture, shared
chat, or successful login is not that proof.

## Join a coding project in the development build

Connect your own ship first. Then **Home → Join a workspace** opens the
project-invitation field; paste the actual link supplied by your host.
Never use the host's ship address or login code as your own connection.

Current source also offers **Join a workspace** on **Your Urbit** once a
read-only invitation-service check succeeds for the authenticated identity.
This button can be available while **Your coding workspace** is unavailable:
accepting an invitation does not require a local coding worker. A missing or
unverified invitation service leaves the setup-page button disabled; changing
your access code will not install it. This new readiness check is source-level
work, absent from the linked preview. Exact-package UI and real owner/guest
acceptance are still required; see the [scoped checks](COMPATIBILITY.md#guest-invitation-readiness-in-current-source).

The owner selects a project and chooses **Invite Collaborator** in **Project
Invitations**. After **Check Result** confirms acceptance, **Copy Join Link**
copies the current matching native invitation for that recipient.

The recipient opens that link, or uses **Join Project**, while connected to
their own ship. **Check Result** reads a retained outcome after a lost response
or restart; it does not resend the join. Joining needs no local Viki session.
The owner can then grant file access in **Project Sharing** and copy the separate
shared-project link described below.

The invitation's deadline limits when it can be accepted. Membership and file
grants last until revoked. **Pending Invitations** provides explicit revoke and
expired-invitation cleanup actions. A join link contains project and recipient
identities, not ship login credentials. Group membership and project membership
remain separate.

## Shared project drafts in the development build

The desktop now has **Open Shared Project**, **Edit Draft**, **Compare**,
**Reconcile**, **Send Suggestion** and **Check Result**. The owner copies a link
from Project Sharing after granting the recipient access. The recipient connects
their own ship and opens that link. It contains project identity and the intended
recipient, with no login code or host credentials.

Edit Draft creates a private working copy. Compare shows its original source;
saving retains local edits without changing the owner's project. Before sending,
Readymade checks fresh source and permissions. If the source changed, use
Reconcile: it preserves the original draft and creates a separate draft for the
new revision. Overlapping changes open a comparison for manual resolution.

Send Suggestion retains a request ID before sending once. Check Result observes
that same request after a lost response. A recorded suggestion is awaiting owner
review; it is not a commit or deployment.

If the sender's ship no longer retains that result, **Recover Owner Receipt**
asks the owner's ship for its existing receipt. It does not resend the edit.
Readymade retains the original outcome alongside the recovery result.

On the owner's side, **Inbox** lists received suggestions for the
selected project. Open a suggestion to inspect it, then **Import as Draft** to
use the normal Changes, candidate and review flow. Import verifies the current
project source and preserves existing owner edits. An outdated suggestion must
be reconciled before it can be imported.

This flow needs the new native shared-source and suggestion endpoints on the
participating ships. The packaged desktop checks use a local fixture service;
live two-ship suggestion review and acceptance remain unfinished. The current
remote source contract supports up to eight shared Hoon files, 32 KiB per file
and 64 KiB total, with ASCII text, tabs and line endings. These limits apply to
this remote protocol, not ordinary local files in the editor.

## See activity in a shared project

After **Open Shared Project** finishes a current source read, expand its
**Activity** row and choose **Refresh activity**. The command palette also has
**Readymade: Refresh Shared Project Activity**. This observes the owner's
filtered activity without publishing your own activity or requiring a local
coding session.

Click a collaborator's file row to open it. Readymade checks that they still
share that file, then requests fresh owner-granted source. A moved, expired or
revoked file is refused; old source is not used as a fallback. If a source read
has an unresolved outcome, use **Check shared project** first.

## Import a Noltbook group message as a coding request

On the project owner's connection, select the actual project and a current
coding session with an existing native grant. Choose **Import Shared Message…**
under **Shared coding requests**, or run **Readymade: Import Shared Message**
from the command palette.

1. Select a Noltbook group, a message, and the session's native grant.
2. Read the full, read-only preview. Check its author, message revision, source,
   project and session; the picker may show only a shortened excerpt.
3. Choose **Import once** to retain that exact request. Importing does not run
   coding tools, start a model job, edit source or submit the request for execution.

This imports messages from Noltbook group conversations, not Tlon Groups or
Shared Document bodies. Document notes do not support timeline messages. Group
membership also does not grant coding permissions: the ship checks current
membership, source, session and execution scope separately.

The imported request opens for inspection. If you later choose to execute it,
open **Readymade: Project Requests**, select the retained request, choose
**Review execution permissions**, review the exact scope, then explicitly
choose **Submit once**. Execution, result review and deployment remain separate.

If importing loses its response or the app closes, return to the same ship,
project and session and choose the retained **Check message import** row.
It observes the original request ID; it does not send another confirmation.
An unavailable or missing receipt is not permission to import again. Results
can be inspected through Project Requests; they are not automatically posted
back into the originating conversation.

## Share a completed result with its original group

The development build adds **Share result with original group…** to the selected
request in **Readymade: Project Requests**. It requires the new native
`workspace-return` backend, a genuinely completed request, and its current
project/session. The first version supports only Noltbook groups hosted by the
connected project owner. It does not support Document bodies or remote-hosted
groups.

1. Enter an owner-written summary. This is your description, not a native verdict.
2. Read the preview's conversation, audience, summary and source revision.
   The full outgoing message appears below the labeled native references.
3. Choose **Share once** only if that exact disclosure is intended.

The message labels the owner-written summary separately from canonical request,
instruction, judgment and evidence references. It does not yet include a rich
changed-file diff or check report. Nothing is executed or posted automatically.

If the response is lost or delivery remains unconfirmed, reopen the same request
and choose **Check shared result**. This observes the original attempt using GET;
it never sends the message again. A missing or unavailable receipt remains
unknown. Only a matching canonical group message establishes delivery.

The packaged editor fixture passed preview, context-change refusal and recovery
without resending. The readable preview is packaged and checked. Native
compilation, saved-state restoration and live deployment preservation are
qualified. Real result-message delivery remains unfinished. Check backend
compatibility before relying on this action.

## Prompt for a coding assistant

> Set up https://github.com/DashusNavnul/readymade so I can collaborate with
> DashusNavnul. Read README.md, docs/LLM_SETUP.md and docs/JOIN_A_WORKSPACE.md.
> Build and verify the desktop, connect my own Urbit through private in-app
> authentication, and open Tlon Groups. Help me use the host's actual invitation;
> ask only for missing connection or invitation details, never my access code.
> Do not send messages, start calls or modify my ship as an installation test.
> Verify shared coding prerequisites and clearly report any missing backend or
> project grant instead of claiming that installation alone enables multiplayer
> execution.
