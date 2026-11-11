# Use your Urbit with Readymade, from inside the app

This page describes what the packaged app does by itself today, and where it
still stops. It covers a planet on this Mac. Nothing here needs a terminal.

## If your planet is already running on this Mac

1. Open Readymade and choose **Connect your Urbit**.
2. Pick your planet from the list. Readymade signs in for you: it asks the ship
   for its own login code over the ship's local owner-only socket. The code is
   read fresh each time and is not stored. If that does not work you are asked
   for the code as before.
3. Your installed apps open inside Readymade.

A hosted planet, or one on another computer, connects by web address and login
code. It cannot be installed to from here yet.

## If you have a planet's keyfile

Choose **Get an Urbit → Start my planet**, or run **Readymade: Start a Planet
from a Keyfile**.

1. Choose the `.key` file. It is inside the passport you download when you
   claim a planet in Bridge.
2. Confirm the planet is not running anywhere else. A planet must only ever run
   in one place.
3. Readymade starts it once, with the Urbit runtime and boot file shipped inside
   the app, in a private folder (`~/.readymade/ships`), reachable only from this
   Mac, with the memory Pataphor needs. The first start takes a few minutes.
4. Choose **Connect to it**.

Readymade never starts a second copy. If a start stops partway, the screen names
the step; do not start the planet from another app.

## Installing Pataphor on a planet

After connecting a local planet that does not have Pataphor, Readymade offers
**Install Pataphor**. You can also run **Readymade: Install Pataphor on This
Ship**.

1. **Install.** One click approves one plan. Readymade checks the ship can run
   Pataphor, copies the backend to a new, separate place on the ship, and builds
   and checks every app there. Your existing apps are not touched. About 17
   minutes on an 8 GB Mac. Closing the page does not stop it, and reopening
   shows where it stands.
2. **Switch Pataphor on.** A second click. The ten new apps start beside your
   existing ones. Readymade then compares your existing apps and their data
   with a record taken just before, and says whether they are unchanged. About
   5 minutes. This is sent once and is not repeated.

If something stops, the page names the step and the recorded reason. Nothing is
retried automatically.

## What a planet needs

- **This Mac:** Apple Silicon, and Python 3 (Apple's Command Line Tools provide
  it; the app says so if it is missing).
- **The Readymade runtime.** Pataphor needs a runtime feature the stock Urbit
  runtime does not have. A planet started by Readymade has it. A planet already
  running on the stock runtime is told so within seconds of choosing Install;
  changing the runtime of an existing planet is not supported from the app.
- **Memory.** The planet must be started with `--loom 33`. Readymade does this
  for planets it starts, and says so before installing on one that was not.

## What has and has not been proven

Proven on fresh test ships (fake identities, no network), driven through the
packaged app's own code, bundled tools, bundled backend and built-in runtime:
install, switch-on, existing apps verified unchanged, and Pataphor's workspace
and coding state served to the signed-in owner while anonymous requests were
refused. Automatic sign-in was also checked against a real running planet.

Not yet proven:

- Starting a real planet from a real keyfile. The key checks, folder and port
  choice were exercised with a correctly formatted test key; no real planet has
  been started by this path.
- Clicking through these screens by hand in the window.
- A first coding task after switch-on.
- Any Mac other than the one it was built on.
