# homebridge-vaillant-heatpump

Monitor a Vaillant air source heat pump (aroTHERM and others on the myVAILLANT app) in Apple Home.

It signs in to the **myVAILLANT cloud** with your normal myVAILLANT account and reads the same data as the app. There is no extra hardware.

> **Unofficial.** Vaillant publishes no interface for this. The plugin follows what the app does, so it can stop working if Vaillant changes it. It was built from the community's published understanding of the service, not from Vaillant documentation, and it is not affiliated with or endorsed by Vaillant. Reads are gentle (one set of requests every two minutes by default).

## What it creates in Apple Home

**One tile, "Vaillant Heat Pump"**, that shows the hot water temperature on its front and that you open to see the parts inside it. Choose **Show as Separate Tiles** in its settings if you want some parts in different rooms or on the main screen.

| Part | What it shows |
|---|---|
| Vaillant Outdoor Temperature | Outdoor sensor |
| Vaillant Heating Flow Temperature | Water leaving the heat pump to the heating |
| Vaillant Hot Water Temperature | Top of the hot water cylinder |
| Vaillant *Zone name* Temperature | One per active heating zone (room temperature) |
| Vaillant Heat Pump Fault Sensor | An alarm (leak-type) sensor that **trips** when the heat pump reports a fault code, so Apple Home sends an alarm notification. |
| Vaillant Heat Pump Compressor State | A read-only switch: on while the compressor is drawing power (over 100 W), off when idle. A tap flips straight back. |
| Vaillant Hot Water Boost (optional) | A switch that starts or cancels a hot water boost. Off by default. |

Upgrading from 0.1.x: those versions made a separate tile for every reading. 0.2.0 replaces them with the one tile above, so the old tiles disappear and the new one starts in your default room.

If the cloud can't be reached, the tiles show "No Response" or a fault in Apple Home until it is back.

**Energy and COP** have no tile in Apple Home. Every 15 minutes the log shows today's energy by series, and a coefficient of performance when the heat made and electricity used can be told apart. The same numbers, and every reading, are saved in `vaillant-heatpump-status.json` in Homebridge's storage folder for other tools to read.

## Set up

1. Install the plugin in Homebridge.
2. Settings: your myVAILLANT email and password, the **country** as the app has it (lower case, no spaces: `unitedkingdom`), and the brand.
3. Restart Homebridge. The log shows `Found system …`, then the readings.
4. Optional: tick **Add a Hot Water Boost switch**. Leave it off if other people can use your Home and you don't want them to start a boost.

Use an account that only you use. Signing in elsewhere (for instance the app on your phone) is fine.

## Notes

- Only systems whose controller the cloud calls `tli` (the usual myVAILLANT gateways), and, for reading, `vrc700`, are handled.
- Faults are read from the cloud's diagnostic codes; the log prints the code text each time it changes.
- The password sits in Homebridge's `config.json` like any plugin setting. Don't share that file.

## Tests

`npm test`. They include a fake myVAILLANT sign-in (cookies, the proof-of-work check, PKCE, token refresh, a 401 retry) and the tile-building. They cannot prove it works against the real service: the first run on a real system is the real test.

Licence: Apache-2.0.
