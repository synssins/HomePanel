# Daedalus

## Description

Daedalus is a wall-tablet dashboard system for Home Assistant. It has two components:

- **Daedalus Workshop** is a Home Assistant add-on. It stores dashboard designs, manages registered tablets, and
  provides the dashboard editor.
- **Daedalus Panel** is a tablet app. It discovers the Workshop over mDNS, registers with it, and renders the
  assigned design. The design is cached on the tablet, so the app starts when the Workshop is unreachable.

Tablets do not store a Home Assistant token. Each tablet is issued its own key and connects to Home Assistant
through the Workshop. Removing a tablet in the Workshop revokes its key.

![Dashboard rendered by Daedalus Panel](docs/img/dash-home.jpg)

## Features

### Dashboards

Tiles are placed freely on the grid and can be grouped by room or by function. A dashboard has one or more pages.
Each tile can use the theme or its own look: fill, gradient, transparency, frosted glass, border, corner radius,
shadow style.

![Dashboard page with a camera tile](docs/img/dash-outside.jpg)

### Controls

A light button follows the light. A light that only switches is toggled by a tap. Any other light opens a popup
with the controls that Home Assistant reports for it: level, colour temperature, colour, effects. Setting a value
on a light that is off switches it on at that value. A button design can show the colour and level of a lit light
on the button. Select entities on the same device as the light, such as presets, are shown
as lists in the popup.

A light group whose members Home Assistant reports opens the same popup for the whole group and lists its
members, each of which opens by itself. On a room page, the group that holds the most lights of the room is shown
as **All lights**, a smaller group inside the room is shown as one button, and its members are not shown
separately. A group that does not report its members, such as a Zigbee2MQTT group, is treated as one light.

The **Scenes** button holds the scenes of a room, a floor, or the whole house. A tap drops a list from the button
and choosing a scene sets it. A scene button is lit while the lights are in the state the scene stores, and no
longer when one of them is changed. Where the button design shows light status, the lit button shows the scene's
lights from left to right in their stored colours. Room pages show one Scenes button for the room.

**Save scene** stores the current state of the lights of a room or a floor as a Home Assistant scene, as a new
scene or over an existing one. The scene is written through Home Assistant's scene editor API by the Workshop, so
it is kept across restarts and remains editable in Home Assistant. Lights, remotes, televisions and receivers are
stored.

Locks, garage doors and alarm panels ask for confirmation before acting. Where Home Assistant requires a code for
the entity, a PIN pad is shown and Home Assistant checks the code. The confirmation is a panel setting.

Thermostats, blinds and other covers, fans and media players open the same popup with the controls each one
reports: target temperature and modes; position, tilt, open, stop and close; speed, preset, oscillation and
direction; volume, transport, mute, source and sound mode with the current artwork.

Numbers open a bar over their range. Selects drop their options from the button. Text, time and date entities open
an entry field that uses the device's keyboard and pickers. Counters, timers, robot vacuums and lawn mowers open
their actions. Valves, humidifiers and water heaters open their level and modes. A siren and an update ask for
confirmation.

**Calendar**, **To-do list** and **Forecast** tiles show upcoming events of one or more calendars, the open items
of a to-do list with check-off and add, and the daily or hourly forecast of a weather entity.

The **Media player** tile shows the picture and title of what is playing with previous, play or pause, and next.
The picture opens the media browser of that player, as Home Assistant provides it: folders open, items play. Search is shown where Home Assistant offers it for the player or the folder, and uses
Home Assistant's search. Pictures are fetched through links signed by Home Assistant. The title opens the player's
controls.

The **Remote** tile opens a remote control for a `remote` entity: power, volume, channels, the four directions with
OK, back, home, menu, play, sources and activities. Button commands are mapped for the Android TV Remote, Samsung
TV, Roku, Apple TV, Bravia and webOS integrations; other remotes show power and activities. Volume and source use
the media player on the same device, or a media player chosen in the editor. A held volume, channel or direction
button repeats. Televisions and receivers are stored in a saved scene as on or off with volume and source.

**Value**, **Gauge** and **Chart** tiles show an entity: its state in large type, a number against a range, or its
history over 1 hour to 7 days. Binary sensors are shown in the words of their device class, such as Open and
Closed for a door.

The **Battery** button lists battery sensors with the lowest first. A light or switch button can show the
battery level of its device where the device reports one.

The alarm panel button opens the arming modes that the Home Assistant alarm entity supports.

### Editor

![Dashboard editor](docs/img/editor.jpg)

- Snap-grid layout with drag and resize.
- Tiles are added by device type (light, switch, lock, media player and others) or, under **Advanced**, by tile type.
- Live preview that uses the tablet renderer and current Home Assistant state.
- Tile types: clock, weather, people, alerts, entity, scene, room, media, camera, page link, text, picture,
  multi-device button, alarm panel, scenes, save scene, battery, value, gauge, chart, calendar, to-do list, forecast, remote, voice assistant.
- Theme settings: background image, tile fill, corner radius, glass effect.
- Designs can be fitted to other screen sizes and orientations.
- Saved changes are pushed to tablets within a few seconds.

### Overlays

30 animated overlays are included. An overlay is drawn over the dashboard and interacts with the tile layout.
Examples: snow, rain, fireflies, koi, vines, goose, tank battle, walkers.

Live demo: [overlay test page](https://synssins.github.io/Daedalus/web/fx-demo.html?kind=snowcrew,goose&opt=always:true).
The overlay is selected in the list under the dashboard. The tiles on this page are not connected to any device.

| | |
| --- | --- |
| ![Snow Crew overlay](docs/img/fx-snowcrew.jpg) Snow Crew | ![Train overlay](docs/img/fx-train.jpg) Train |
| ![Goose taking a tile](docs/img/fx-goose-steal.jpg) Goose taking a tile | ![Goose chasing the Snow Crew](docs/img/fx-goose-crew.jpg) Goose chasing the Snow Crew |
| ![Goose derailing a train](docs/img/fx-goose-train.jpg) Goose derailing a train | ![Walkers overlay](docs/img/fx-walkers.jpg) Walkers |

## Installation

### Daedalus Workshop

1. In Home Assistant, open **Settings > Add-ons > Add-on Store > Repositories**.
2. Add `https://github.com/synssins/Daedalus`.
3. Install **Daedalus Workshop** and start it.
4. Open **Daedalus** in the sidebar.

Supported architectures: amd64, aarch64. The add-on uses the host network on port 8722 and is advertised over mDNS
as `_daedalus._tcp`.

### Daedalus Panel

The app is not distributed through the App Store. The current build targets iPadOS 15 and is installed over SSH on
a jailbroken device.

1. Push the repository to GitHub. The `build` workflow compiles the app and uploads `DaedalusPanel.app.tar` as an
   artifact.
2. Place the SSH private key for the tablet's `mobile` user at `~/.ssh/ipad_panel_ed25519`.
3. Run the deploy script:

```powershell
.\deploy.ps1 -Ip <tablet address>
```

`deploy.ps1` downloads the latest build artifact, installs it over SSH, and launches the app. The `-WebOnly` switch
copies only the `web` folder.

## Usage

1. Open Daedalus Panel on a tablet on the same network as Home Assistant. The tablet is listed under **Tablets**
   as waiting.
2. Select **Approve** and assign a design.
3. Open the design in the editor, make changes, and select **Save**.

The Workshop also serves the rendering engine to tablets. Updating the add-on updates the engine on all tablets.
The app requires reinstallation only for changes to native code.

## Development

Run the Workshop locally against a Home Assistant instance:

```sh
cd addon
HA_URL=http://homeassistant.local:8123 HA_TOKEN=<long-lived token> DAEDALUS_MDNS=0 \
  uv run --with-requirements requirements.txt python -m server
```

The editor is served at `http://127.0.0.1:8722/`. `DAEDALUS_MDNS=0` disables mDNS advertising, so tablets do not
connect to the development instance.

- Store tests: `python addon/tests/test_store.py`
- Scene capture tests: `python addon/tests/test_scenes.py`
- Overlay test page: `web/fx-demo.html?kind=walkers`
- Popup and confirmation tests: `node tests/guard-test.js`. The test uses a development Workshop on port 8723,
  invented entities, and records service calls without sending them.

## Repository layout

| Path | Description |
| --- | --- |
| `Sources/` | Tablet app shell (Swift, WKWebView) |
| `web/` | Renderer: tiles, overlays, voice assistant |
| `addon/server/` | Workshop server (Python, aiohttp) |
| `addon/studio/` | Workshop page and editor |
| `addon/renderer/` | Copy of `web/` served by the add-on |

## Credits

Background photo in the screenshots: "Snowy mountains at dusk" by Nitish Meena, CC0, via Wikimedia Commons.
