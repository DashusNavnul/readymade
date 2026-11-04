# Join a Readymade workspace

To work with [DashusNavnul](https://github.com/DashusNavnul), start by setting up
Readymade on your own computer and connecting your own Urbit. Each participant
keeps their own ship login private. A collaborator's access code is not an
invitation and is never needed for joining a group.

## What you can set up from this repository

Follow [LLM setup](LLM_SETUP.md) to build the desktop on an Apple Silicon Mac.
Configure your ship origin, authenticate privately, then open Groups, Glurff,
Calls or Landscape if those apps are already installed on your ship. In a new
Readymade terminal, `groups` opens Tlon Groups and `landscape` opens the app
launcher. Both reveal retained tabs without reloading them.

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

The public repository currently ships the desktop, not a self-service installer
for the native shared coding backend. Full independent two-person coding
acceptance is not established. An LLM cannot complete that missing installation
by following this guide alone.

For backend-enabled collaboration, the host must supply the actual project and
session identifiers, participant admission, permitted actions, and a compatible
backend connection arrangement. The receiving ship must expose the protocols in
[compatibility](COMPATIBILITY.md), with the necessary grants and model/provider
connection. Do not substitute the host's owner login or forward its credentials.

Inspect the project/session and shared request catalog before submitting work.
If the required backend is absent, stop that part of setup and report the missing
requirement. Keep working local editor and app access available. Do not install
unverified ship agents or manufacture grants to make a demo appear connected.

Before describing a session as working shared execution, verify that both real
participants can observe the intended project/request and that one deliberately
authorized, bounded coding request produces the correlated result. Distinguish
request recording, execution, review and deployment. A local fixture, shared
chat, or successful login is not that proof.

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
