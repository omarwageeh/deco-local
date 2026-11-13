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
| **More** | System toggles (Wi-Fi bands, IGMP, WAN unicast, flow control, wireless forward), time, system log, API console |

## Run it

Requires [Node.js](https://nodejs.org) 18 or newer. There are no dependencies to install.

```sh
npm start          # or double-click start.bat on Windows
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

## License

[MIT](LICENSE). Deco Local is not affiliated with or endorsed by TP-Link. "Deco" and "TP-Link" are trademarks of TP-Link.
