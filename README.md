# MeshJuice Dashboard

Web Serial dashboard for the MeshJuice 10. It is a visual wrapper around the firmware's
USB CLI: every value, limit, default and option list is read from the device, and every
change is validated by the device.

```
npm install
npx vite --port=4000        # then open http://localhost:4000 in Chrome or Edge
npm run build               # static build in dist/
```

Web Serial needs Chrome or Edge, served from `localhost` or HTTPS.

## Hosting (GitHub Pages)

Every push to `main` builds the site and deploys it with `.github/workflows/deploy.yml`.
In the repo, go to Settings → Pages and set Source to **GitHub Actions** once. The site is
then served at `https://<owner>.github.io/<repo>/`. Assets use relative paths
(`base: './'` in `vite.config.js`), so the repo name doesn't matter. GitHub Pages serves
over HTTPS, so Web Serial and WebUSB both work there.

## How it talks to the firmware

| Dashboard                        | CLI command                                  |
| -------------------------------- | -------------------------------------------- |
| Telemetry / config values        | `get <key>` (batched)                        |
| Edit dialog: current/default     | `get`, `default`                             |
| Edit dialog: min/max/step        | `min`, `max`, `step`                         |
| Edit dialog: choices             | `options`                                    |
| Live validation in the dialog    | `valid <key> <value>`                        |
| Apply / Import Config            | JSON line `{"key": "value", ...}`            |
| Export Config                    | `get` for every config key                   |
| Save Changes                     | `save`                                       |
| Reboot / Factory Reset           | `reboot` / `erase`                           |
| RTC                              | `time`, `time YYYY-MM-DD HH:MM:SS`           |
| Allow / Inhibit Charging         | `chg on` / `chg off`                         |
| Output On / Off                  | `on` / `off`                                 |
| Power History                    | `history 168`                                |
| Diagnostic                       | `log <count>`                                |
| Erase History / Erase Log        | `history clear` / `log clear`                |
| Firmware: Enter DFU Mode         | `dfu`                                        |

The Firmware tab flashes `.bin`/`.hex` builds through the STM32's ROM USB DFU bootloader with
WebUSB (`src/lib/dfu.js`). Enter the bootloader with `dfu` or by holding PKEY while resetting
the board. On Windows the bootloader (0483:DF11) needs the WinUSB driver (Zadig).

`min`, `max`, `step` and `options` need firmware that includes those commands.

## Layout

- `src/lib/serial.js`: Web Serial link; one reader, exclusive command transactions.
- `src/lib/device.js`: one method per CLI command, plus reply parsing.
- `src/lib/layout.js`: which property appears where, with its label and display unit.
  To show a new firmware property, add it here.
- `src/components/EditDialog.svelte`: edit popup. Closes only when the firmware accepts
  the value, or on Cancel.
