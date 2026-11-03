# Event Notes

A phone web app for logging conversations at in-person events. Search a guest
by name or practice, type what you talked about, tap **Save**, and it lands in
the guest-list Google Sheet.

- **Live search** across name, practice, role and email. Matching ignores
  accents and works from the first letters you type.
- **Team notes:** each guest shows "2 notes" once colleagues have spoken to
  them. Open the guest to see who said what, so the next person doesn't repeat
  the same pitch.
- **Quick tags** (Wants a demo, Follow up, Hot lead…) that you can tap instead
  of typing.
- **Walk-ins:** "+ Add someone not on the list" uses the name you've typed.
  The new person is then searchable for the rest of the team.
- **You know it's in.** After you tap Save, the phone says *Sending…*. It
  only shows a green **Saved to sheet** once the sheet has replied that the
  row is written. The home screen always shows a status line:
  - green: *All 5 of your notes are in the sheet · checked 17:41*
  - amber: *1 note NOT sent yet · kept on this phone · tap to retry*
- **Bad signal is fine.** Unsent notes stay on the phone, labelled *not sent
  yet*, and go automatically when signal returns, even after the app is
  closed. They are never sent twice. In private browsing the phone can't
  keep them, and a red banner says so.
- **Drafts survive.** If you leave half-way through a note, it's still there
  when you come back.

No hosting, no API keys. It's a Google Apps Script web app attached to the
sheet itself. It is styled with **Suvera Flow**, the same design tokens as
ops.suvera.com (`docs/design/suvera-flow.md`).

## Where the data goes

The app reads the **Guests** tab (`Full name | Email | Practice / organisation | Role`).
It writes to a **Notes** tab, which it creates on the first save:

| Timestamp | Team member | Full name | Email | Practice / organisation | Role | Tags | Note | Walk-in |
|---|---|---|---|---|---|---|---|---|

It writes one row per conversation and only ever adds rows, so team members
saving at the same moment can't overwrite each other. Saves take turns behind
a lock, and each holds it only for the quick append. If a save ever times out
waiting, the phone keeps the note and retries. The hidden Entry ID column
stops a retry from writing the note twice. (Tested: 12 people saving on the
same guest at once gives 12 rows, and a repeated retry adds nothing.) Rows added to **Guests**
during the event show up in the app within 30 seconds.

There is also a **By guest** tab for follow-up: one row per guest with every
note combined (`Full name | Practice | Role | Email | Conversations | Spoken to by | Tags | Last spoken | All notes (newest first) | Walk-in`).
Guests someone spoke to come first, sorted by most conversations. Everyone
nobody reached is listed below them. The tab rebuilds after every save and
whenever Notes or Guests is edited by hand. To rebuild it manually, use the
sheet menu **Event notes → Rebuild "By guest" tab**. Don't edit By guest
itself, because it gets overwritten; edit Notes instead.

## Set up (about 5 minutes, once)

1. Open the guest-list sheet → **Extensions → Apps Script**.
2. Replace everything in `Code.gs` with [`Code.gs`](Code.gs).
3. **＋ → HTML**, name it `Index` (exactly), and paste [`Index.html`](Index.html).
4. `CONFIG.TEAM` at the top of `Code.gs` already lists the team (Aleena,
   Ben, Caitlin, Camilla, CJ, Ellena, Ivan, Ram, Roland, Ryan, Ryzard, Will).
   People tap their name once. Add or remove names there; they always show A-Z.
5. *(Recommended)* Set a team PIN: **Project Settings (⚙) → Script properties →
   Add**. Property `ACCESS_PIN`, value e.g. `2468`. Anyone without the PIN
   can't see the guest list or write notes. The PIN is kept out of the code, so
   it never ends up in git.
6. **Deploy → New deployment →** type **Web app**.
   - Execute as: **Me**
   - Who has access: **Anyone**. Team phones don't need to be signed into
     Google; the PIN is the gate.
   - **Deploy**, approve the permissions prompt, and copy the `/exec` URL.
7. Send that URL to the team.

### Add to home screen

- **iPhone:** open the link in **Safari** → Share → **Add to Home Screen**.
- **Android:** open in **Chrome** → ⋮ → **Add to Home screen**.

On first open each person enters their name (and the PIN). The phone
remembers it from then on.

### Changing the code later

**Deploy → Manage deployments → ✏️ → Version: New version → Deploy.**
This keeps the same URL, so nobody needs a new link. Changes to `CONFIG`
(team names, tags) also need a new version.

## Tips for the day

- The keyboard's microphone button works in the note box. Dictating is
  faster than typing between conversations.
- Press **Go/Enter** in the search box to open the top match.
- **Only trust green.** Before you pocket your phone, glance at the status
  line. Amber means a note is still on your phone: keep the app open, or tap
  to retry when you have signal. The team can check the **By guest** tab on a
  laptop too.
