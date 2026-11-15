# Deco Local

Manage your TP-Link Deco mesh from your own network, with no internet and no TP-Link cloud.

The official Deco app goes through TP-Link's cloud, so it stops working when your internet is down. Deco Local talks directly to the main Deco's built-in local API. That's the same encrypted API its hidden web page at `https://<deco-ip>/webpages/` uses, so it keeps working offline.

## Features

| Tab | What you can do |
| --- | --- |
| **Overview** | Internet status, WAN/LAN info, number of Decos and clients online, CPU and memory |
| **Decos** | Every unit with its model, firmware, backhaul and signal; reboot one or all |
| **Clients** | Every device with its IP, MAC, band, the Deco it's attached to and live speed; search and filters |
| **Wi-Fi** | SSIDs and passwords (show/copy) for main and guest networks; transmit power; *experimental* editing |
| **More** | Internet connection (PPPoE, dynamic or static IP), DHCP server and address reservations, operation mode (Router / Access Point), system toggles (Wi-Fi bands, IGMP, WAN unicast, flow control, wireless forward), time, system log, API console |

## Run it

Requires [Node.js](https://nodejs.org) 18 or newer.

```sh
npm install --omit=optional   # once; the only dependency is ssh2
npm start                     # or double-click start.bat on Windows, which does both
```

Then open http://localhost:8686. The server also prints a LAN address (for example `http://192.168.100.12:8686`) that you can open on your phone. Add it to your home screen and it works like an app.

Log in with:

- **Deco address**: your main Deco's IP, which is usually your PC's default gateway (`ipconfig`).
- **Password**: the Deco's local management password. On most setups this is the password of the TP-Link ID that owns the network.

Wrong passwords count toward the Deco's lockout. After several failures it blocks logins for a while.

### Options

| Env var | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8686` | Port for the web UI |
| `BIND` | `0.0.0.0` | Use `127.0.0.1` to allow only this PC |
| `DECO_LOCAL_CONFIG` | `./deco-config.json` | Where the last-used Deco address is stored (the password is never saved) |
| `DECO_DEBUG` | off | Set to `1` to log every Deco request and how long it took. Requests slower than 1.5 s are always logged. |

## Internet connection (PPPoE, dynamic or static IP)

**More → Internet connection** shows every WAN field your Deco reports. **Edit** changes the connection type, the PPPoE username and password, static IP details, DNS and MTU.

Editing uses the same local protocol as the Deco app (see Operation mode below), and builds the request exactly the way the Deco app 3.10.666 does:

- The request is opcode `0x4005` with `{"wan": {...}}`, the same layout the Deco reports.
- The username and password are sent base64-encoded.
- PPPoE credentials are sent only when they change. Leave the password blank and the Deco keeps the saved one.
- MTU limits are 576–1492 for PPPoE and 576–1500 for Dynamic or Static IP.

L2TP and PPTP aren't supported yet.

Saving reconnects your internet. If the details are wrong, the internet stays down until you fix them, and Deco Local can do that without internet.

## DHCP

**More → DHCP** shows and changes:

- **DHCP server:** the address range the Deco hands out and the DNS servers it gives devices (blank means the Deco itself). The lease time can also be changed, from 1 to 1440 minutes, but only on Decos that report one; the Deco app hides it otherwise.
- **Address reservations:** always give a device the same IP. Add them from the list of current devices, or from **Reserve IP** in a client's details on the Clients tab. You can also enter a MAC address yourself, and edit or remove reservations.
- **Current leases:** which device has which address right now.

Like the Deco app 3.10.666, Deco Local uses opcodes `0x4213` / `0x4214` for the server, `0x40C0` to `0x40C3` to list, add, modify and remove reservations (removing by MAC), and `0x423D` for leases. It uses the same local connection as Operation mode below, so it needs your TP-Link ID.

## Operation mode (Router / Access Point)

The Deco's HTTP API can only *read* the mode. To switch it, Deco Local uses the protocol the Deco app itself uses on your local network: SSH to port 20001 on the main Deco, then TP-Link's "TMP" messages. That protocol signs in with your **TP-Link ID email and password**. They are checked by the Deco itself, not over the internet.

- Deco Local keeps the password in memory only. It saves the email and the Deco's SSH key fingerprint, and refuses to send your password if that key changes later.
- The Deco locks this sign-in after repeated failures, so Deco Local never retries a rejected password.
- After a change, the Deco may close its control port for about 1–2 minutes, and connecting during that time keeps it closed longer. Deco Local pauses changes and checks the port every 5 seconds. It resumes once the port is back, or after 25 seconds if the port never closed. The longest pause is 2.5 minutes.
- Switching to **Access Point** mode stops the main Deco handing out addresses. It gets its address from your modem/router instead, so it won't be at its old IP. Find it in your modem/router's device list and log in to Deco Local again.
- The mode-switch command (opcode `0x40A1`) was worked out from the Deco app and hasn't been confirmed on every model. Have another way into your modem/router before you try it.

## Things to know

- **One admin session.** A Deco allows only one local admin session at a time. Logging in here can sign out the Deco's web page, and the other way round. Deco Local logs back in automatically when that happens.
- **Wi-Fi editing is experimental.** The Deco's local web page only *reads* Wi-Fi settings, and the Deco app changes them through the cloud. Deco Local sends the change to the same local endpoint. Depending on firmware, the Deco may reject it, in which case you'll see an error and nothing changes. Everything else here is what the Deco's own local web page writes.
- **API console.** The *More* tab can call any local endpoint. Stick to `read` unless you know what a write does.
- **Security.** Anyone on your LAN can open the page, but nothing works without the Deco password. Use `BIND=127.0.0.1` if you only want access from this PC.

## Try it without a Deco

```sh
npm run mock       # fake Deco on 127.0.0.1:8787, password "decopass"
npm start          # then log in to 127.0.0.1:8787
```

The mock implements the real protocol, including RSA-signed requests, AES-encrypted payloads and session tokens, and keeps state so changes stick. Set `MOCK_DELAY_MS=300` to make it as slow as a real Deco.

## Why it's fast

A Deco closes the connection after every response, so each request needs a new TLS connection, about 0.3–0.5 s on its CPU. Deco Local does three things about that:

- It resumes TLS sessions instead of doing full handshakes.
- It sends requests in parallel, like the Deco's own web page does, so a screen takes about one round trip.
- It briefly caches the Deco and client lists so switching tabs reuses them, and the UI shows each tab's last data instantly while it refreshes.

## Tests

```sh
npm test
```

## How the protocol works

See the header comment in [`src/deco-client.js`](src/deco-client.js). In short:

1. Fetch an RSA key for the password and an RSA key plus a sequence number for signing.
2. Pick a random AES-128-CBC key.
3. Send every request as `sign=<RSA(k,i,md5("admin"+pwd),seq+len)>&data=<AES(json)>`.
4. Login returns a `stok` token and a `sysauth` cookie.

The TMP protocol used for operation mode is described in [`src/tmp-client.js`](src/tmp-client.js). It is based on the reverse engineering in [mthsg/pydeco-tmp](https://github.com/mthsg/pydeco-tmp) and [ukbodypilot/deco-local](https://github.com/ukbodypilot/deco-local), both MIT-licensed.

## License

[MIT](LICENSE). Deco Local is not affiliated with or endorsed by TP-Link. "Deco" and "TP-Link" are trademarks of TP-Link.
