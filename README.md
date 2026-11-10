# Travel Splitter

Track shared travel expenses for up to 10 people and split costs automatically.
No dependencies — just Node.js.

## Run

Needs Node.js 18 or newer.

```bash
cd travel-splitter
npm start            # or: node server.js
```

Open http://localhost:3000. To use another port: `node server.js 8080` or `PORT=8080 npm start`.

**Your data** lives in `data.json` next to `server.js`. It holds every account (password
hashes included), trip and expense, so **back it up** (copy it while the server is stopped)
and don't share it. Delete it to start fresh. If it's ever damaged, the server refuses to
start rather than overwrite it.

### Sharing with your group on the same Wi-Fi

By default the server only accepts connections from this computer. To let others on your
network use it, start it with `HOST=0.0.0.0`:

```bash
HOST=0.0.0.0 npm start
```

They then open `http://<your-computer-ip>:3000`. **Plain HTTP sends passwords and session
cookies unencrypted**, so anyone on the same network (e.g. café or hotel Wi-Fi) could read
them. Prefer HTTPS: create a certificate (for example with
[mkcert](https://github.com/FiloSottile/mkcert), or a self-signed one) and point the server
at it:

```bash
HOST=0.0.0.0 TLS_CERT=cert.pem TLS_KEY=key.pem npm start
```

With HTTPS on, the session cookie is also marked `Secure`.

## Development

The app itself has no dependencies. Linting needs dev dependencies (ESLint), so run
`npm install` once. Tests use Node's built-in runner (Node 22+).

```bash
npm test           # API + unit tests
npm run lint       # ESLint
npm run check      # both; this is what CI runs on every push and pull request
npm run coverage   # tests with a coverage report
```

Tests start the real server on a random port against a throwaway data file
(`TS_DATA_FILE`), so your `data.json` is never touched.

## Accounts
- Everyone logs in with their own **username and password**.
- **Create account**: enter your name, a username and a password (max 10 people).
  If a friend already added you, also enter the **invite code** they were shown. You then
  take over that spot, with its trips and expenses. Each code works once.
- Passwords are stored hashed (scrypt), never in plain text. Sessions last 30 days, and
  only a hash of each session token is stored. Each person keeps at most 10 sessions.
- 5 wrong passwords in a row locks that username for 1 minute; each further lockout is
  twice as long (up to 1 hour). One network address that gets 30 logins wrong, across any
  usernames, is locked out the same way.
- **Change password** needs your current password, with the same lockout. 5 wrong guesses
  also log that session out. Changing your password logs you out everywhere else.
- **Forgot password?** Whoever runs the server can reset it. **Stop the server first**
  (the command refuses to run while it's up, because the running server would overwrite
  the change), then:
  ```bash
  node server.js reset-password <username> <new-password>
  ```
  This also signs that user out everywhere. Start the server again afterwards.

## Who can do what
- You only see trips you are on.
- Expenses: any trip member can add one; only the person who **added** or **paid**
  for it can edit or delete it (others see a 🔒).
- Trips: any member can edit; only the person who created it can delete it, and the
  creator can't be removed from their own trip.
- People: you can add buddies who haven't signed up yet ("invited"). You get an invite
  code to send them (🔗 shows it again). You can rename or remove an invited person if you
  added them or share a trip with them. Only you can rename yourself.
- Each user only sees their own username; invite codes are only shown to people who can
  manage that invitee.
- Currencies must be a real 3-letter code (USD, EUR, SGD, JPY, …).

## Features
- **Trips**: create, edit (name, currency, members), delete.
- **Expenses**: add, edit, delete, search. Each has a payer, date, category and notes.
- **Split modes**: evenly among selected people, exact amounts, percentages, or shares (weights).
  Rounding is handled to the cent so shares always add up to the total.
- **Balances & Settle up**: who paid what, each person's share, and the fewest
  payments needed to square everyone up.
