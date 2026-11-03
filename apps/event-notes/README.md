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
- **Bad signal is fine.** Notes are kept on the phone and sent automatically
  when signal returns, even after the app is closed. They are never sent twice.
- **Drafts survive.** If you leave half-way through a note, it's still there
  when you come back.

No hosting, no API keys. It's a Google Apps Script web app attached to the
sheet itself.

## Where the data goes

The app reads the **Guests** tab (`Full name | Email | Practice / organisation | Role`).
It writes to a **Notes** tab, which it creates on the first save:

| Timestamp | Team member | Full name | Email | Practice / organisation | Role | Tags | Note | Walk-in |
|---|---|---|---|---|---|---|---|---|

It writes one row per conversation and only ever adds rows, so team members
saving at the same moment can't overwrite each other. Two hidden plumbing
columns (Guest key, Entry ID) handle de-duplication. Rows added to **Guests**
during the event show up in the app within 30 seconds.

## Set up (about 5 minutes, once)

1. Open the guest-list sheet → **Extensions → Apps Script**.
2. Replace everything in `Code.gs` with [`Code.gs`](Code.gs).
3. **＋ → HTML**, name it `Index` (exactly), and paste [`Index.html`](Index.html).
4. *(Optional)* In `CONFIG` at the top of `Code.gs`, fill in `TEAM` with the
   7 names, e.g. `TEAM: ['Will', 'Sam', …]`. People then tap their name
   instead of typing it, which keeps the names consistent in the sheet.
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
- An amber "⏳ waiting for signal" pill means notes are safe on the phone and
  haven't reached the sheet yet. Tap it to retry.
