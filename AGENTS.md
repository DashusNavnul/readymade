# Readymade contributor and setup instructions

For connecting a user's Urbit, read README.md and docs/LLM_SETUP.md first.
Read docs/COMPATIBILITY.md before assuming backend availability.

Never request access codes in chat or commit credentials, cookies, profiles,
private ship data or local logs. Use the private in-app authentication field.
Connecting existing apps does not require booting or modifying a ship.

Keep ship authority and permission checks on Urbit. Desktop drafts are local;
a saved draft or submitted request is not proof of a deployed change.
Do not retry an unknown write without observing its canonical outcome.

Run npm run check, npm run lint and npm test for code changes. Use the packaged
host for integration tests; stock editors lack Readymade's native media bridge.
Distinguish fixture results from real ship, camera and peer acceptance.
Preserve upstream copyright and license notices.
