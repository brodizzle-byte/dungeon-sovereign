# Gladiator Nights — the relay

`gladiator.js` is a lockstep **relay**, not a game server. It never
simulates the arena; every player's machine does that in full. The relay
decides, for each tick, the single authoritative set of inputs and hands it
to everybody.

That distinction is the whole design. A client never guesses what a missing
player did — if it did, two clients could guess differently and the match
would quietly fork. When a packet is late the *server* decides on that
player's behalf (repeat their last input) and tells everyone the same
thing, so a bad connection costs that player fidelity instead of costing
everyone the match.

No npm dependencies, deliberately: the droplet has node but no npm, and a
WebSocket server is a handshake and a frame parser.

## Deploying

```bash
# 1. the shared secret — PHP mints tickets with it, the relay checks them.
#    Never in git.
head -c 32 /dev/urandom | base64 > /var/www/juicebox/dungeon/data/gladiator.secret
chown www-data:www-data /var/www/juicebox/dungeon/data/gladiator.secret
chmod 640 /var/www/juicebox/dungeon/data/gladiator.secret

# 2. the matches directory the bot writes rosters into
install -d -o www-data -g www-data /var/www/juicebox/dungeon/data/matches

# 3. the service
cp /var/www/juicebox/dungeon/server/gladiator.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now gladiator
systemctl status gladiator --no-pager

# 4. nginx: add the /dgws location from nginx-dgws.conf into the
#    juicebox server block, then
nginx -t && systemctl reload nginx

# 5. check
curl -s http://127.0.0.1:8787/health
```

## Verifying

Three gates, all in `../replay/`:

| gate | proves |
|---|---|
| `parity.js` | browser and server agree for one player (solo bounties) |
| `lockstep.js` | two independent engines agree for several players |
| `netmatch.js` | they still agree **through the real relay** |

`netmatch.js` needs a node with a built-in WebSocket *client* (21+). The
relay itself uses only `http` and `crypto`, so node 18 runs it fine.

## The input log

Every settled tick is appended to `<match>.log` next to the roster. Since
the arena is deterministic from the seed plus that log, any disputed result
can be re-simulated later rather than argued about — the same property the
solo bounty replay already relies on.
