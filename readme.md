# MeshCentral-ScriptTask

A script runner plugin for [MeshCentral](https://github.com/Ylianst/MeshCentral). Keep PowerShell, Batch and Bash scripts in a central library, run them on one device or many, schedule them, and review their output.

Maintained by Desmond Duval. This is a fork of [ryanblenis/MeshCentral-ScriptTask](https://github.com/ryanblenis/MeshCentral-ScriptTask), the original plugin by Ryan Blenis, with a redesigned interface that fits MeshCentral's Modern UI, a server-wide management page, batches, and a new scheduling engine. See the [changelog](changelog.md) for everything that changed.

![Overview](docs/screenshots/overview.png)

## Requirements

- MeshCentral 1.2.0 or later, using the **Modern UI**. The Classic UI shows a notice asking you to switch.
- Plugins enabled in MeshCentral's `config.json`:
  ```json
  "plugins": { "enabled": true }
  ```
  Restart MeshCentral after changing it.
- NeDB (MeshCentral's default) or MongoDB.

## Installation

In MeshCentral, go to **My Server > Plugins**, choose **Download Plugin**, and enter:

```
https://raw.githubusercontent.com/dduval-sgo/MeshCentral-ScriptTask/master/config.json
```

Then enable the plugin, and **restart MeshCentral**.

**Restart MeshCentral after installing, upgrading or removing the plugin.** MeshCentral keeps a plugin's server code in memory until it restarts. Without a restart, a newly installed version can keep running the previous version's code: you'd see the old pages, or "Unauthorized" on the ScriptTask page. From version 0.1.1, ScriptTask notices a version change and loads its new code itself, but a restart is still the reliable way. After restarting, reload MeshCentral in your browser (Ctrl+F5).

**Switching from the original plugin:** both use the plugin name `scripttask` and the same database (`plugin-scripttask.db` in `meshcentral-data` for NeDB, or the `plugin_scripttask` collection for MongoDB), so scripts, schedules, history and variables carry over. Back up your data first, remove the original plugin, install this one, then restart MeshCentral. Permissions are not carried over: the original plugin had none, so nobody can use this one until you grant a permission (see Permissions). The original plugin can't detect the change, so the restart is required here. Existing schedules keep working as before: they run when an offline device reconnects, on their original timetable.

## Private scripts

The library has a **Private** folder next to Shared, created the first time a full administrator opens the library. Only MeshCentral **full administrators** who are also allowed in ScriptTask (Manage ScriptTask, or Run scripts on the device) can see it. Nobody else sees the folder, its scripts, or anything about them: their runs, schedules, batches and history, their output, and the variables set for them are all left out of every list and every request for everyone else, managers included. The Overview counts leave them out too, and a script's download and its `#variables#` usage are refused for others.

Private scripts can't be shared by accident: nothing can be moved out of Private, and nothing can be moved into it. To make a private script, create or upload it inside Private. To share one, copy its text into a new script in Shared. The Private folder itself can't be renamed, moved or deleted. A user who stops being a full administrator stops seeing Private at once, and the scripts stay where they are.

Private is not encryption: a script's text is stored like any other script, and it is sent to a device when it runs there. Variables used by a private script keep their own scopes (global, device group and device variables are shared with everyone who can see them).

## Where to find it

- **ScriptTask page** (for ScriptTask managers): **My Server > Plugins > ScriptTask**, or **Open ScriptTask** on any device's ScriptTask tab.
- **Device tab**: each device's **Plugins** tab has a ScriptTask section to run and schedule library scripts on that device, with its queue and history.

## Permissions

ScriptTask registers two MeshCentral plugin permissions:

| Permission | Default | Allows |
|---|---|---|
| **Manage ScriptTask** | Denied | The ScriptTask page: editing the library and variables, running or scheduling on many devices, and server-wide queue, schedules, history and settings. |
| **Run scripts** | Denied | Running and scheduling library scripts on a single device from its tab, and seeing that device's queue and every past run on it. |

**Every permission is denied by default. After installing or upgrading, nobody can use ScriptTask until an administrator grants a permission** in MeshCentral's plugin permissions dialog (global, device group or device). This includes people who could run scripts before version 0.2.0. The most specific setting wins: device, then device group, then global, then the default (denied). "Inherited" falls through to the next level, so a global "inherited" means denied, and an "allowed" on a device group or device overrides it.

Running a script on a device also needs that device's **Remote Commands** right, and the user must be able to see the device. ScriptTask does not assume that MeshCentral full administrators are always allowed: it uses MeshCentral's answer, and writes the user's `siteadmin` value next to each decision in the MeshCentral log so you can see which it is on your server. Only if MeshCentral has no plugin permission API at all (or ScriptTask's permissions could not be registered) are full administrators the only users allowed. Managers only see devices, runs and variables for devices they can see in MeshCentral.

If a permission check fails for any reason (an error, a missing or unexpected answer), the user is refused.

### Deleting batches

**Delete** on a batch removes it from Batches. Runs that haven't been sent to a device are cancelled, and the schedules of a scheduled batch are deleted. Runs already sent finish where they are. Finished runs stay in History without the batch, unless you tick **Also delete the finished runs from History**. A batch that includes a device you can't see in MeshCentral is left alone, because deleting it would change schedules and runs on that device (devices deleted from MeshCentral don't count).

### What the permissions can and can't enforce

- **Enforced on the server:** every request the ScriptTask pages send (library, variables, runs, schedules, history, settings, the script download) is checked on the server before it runs, so hiding or showing parts of the page is not what protects anything. Someone with no ScriptTask permission also gets no settings back from the plugin's start-up request.
- **Pages and files are served only to allowed users.** The device tab's page is refused (and the tab hidden, where MeshCentral's page lets ScriptTask do that) unless the user has the **Run scripts** permission on that device and its Remote Commands right, or is a manager who can see the device. The ScriptTask page needs **Manage ScriptTask**. The page's scripts and styles are sent only to a user who has passed one of those checks in the last 8 hours (the time is renewed by each permitted request).
- **Change notices** (which device, script or setting changed, with no content) go only to signed-in users who passed a ScriptTask check in the last 8 hours, and for a device only if they can see it. Someone whose permission was just removed can keep receiving these notices (ids only, no data) until they next use the plugin or the 8 hours pass; every request they make is refused at once.
- **Outside ScriptTask:** anything a user can do directly with MeshCentral (its own Console and Run commands, terminal and file access on a device they have rights to) does not pass through this plugin and is controlled by MeshCentral's device rights, not by these permissions.
- **Changes take effect on the next request.** A grant works without restarting MeshCentral, and a revoke stops the next request from that user. A page that is already open keeps showing what it loaded until it asks again.
- On MeshCentral 1.3.1 with MySQL, a known MeshCentral problem (#8307, `getPluginPermissions is not a function`) can stop saved permissions from loading. If it appears in the console or `meshcentral-data/mesherrors.txt`, it is a MeshCentral bug that a plugin can't fix; ScriptTask then refuses everyone except full administrators.

After upgrading, restart MeshCentral and reload the page with Ctrl+F5: a browser that cached the old client code has none of the new behaviour.

Users can cancel their own pending runs and change or delete their own schedules. Managers can act on anyone's.

## The ScriptTask page

| Section | What it does |
|---|---|
| **Overview** | Queue counts, errors, missed and completed runs in the last 24 hours, runs that need attention, what runs next, and recent batches. |
| **Library** | Folder tree (drag to move, drop files to upload) and, for each script, a code editor plus its schedules, history and variables. Full administrators also have a **Private** folder (see below). |
| **Run** | Pick a script and devices (search, device groups and tags with checkboxes so you can choose several, OS, online status, saved device sets), then run now or schedule. Several groups match devices in any of them. Several tags match devices with any of them, or with all of them if you choose **All**. |
| **Batches** | Runs on several devices, with devices grouped by identical output, CSV export, and Run again on failed devices. Delete a batch from its page, or tick several in the list and choose Delete. |
| **Queue** | Every pending run, with filters and bulk cancel or run now. |
| **Schedules** | Every schedule, soonest first, with bulk edit, pause, resume and delete. Select schedules and choose Edit to give them all one new timetable. |
| **History** | Every finished run, searchable by output, with the full output on click. |
| **Variables** | All variables in one place, where each is used, and names scripts use that aren't defined. |
| **Settings** | Plugin-wide settings (below) and your code editor theme. |

### Code editor

The editor (CodeMirror 6) has line numbers, PowerShell, Bash and Batch highlighting, search and replace, Tab indenting and Ctrl+S to save. `#variables#` are highlighted, with their values on hover and unknown ones underlined. Line endings (CRLF or LF) are kept; Bash scripts are always saved with LF.

Each user picks their own code theme: Darcula, Dracula, Eclipse, GitHub Light/Dark, Monokai, Nord, One Dark, Solarized Light/Dark, Tokyo Night, VS Code Light/Dark, or Auto (follows MeshCentral's light or dark mode).

### Keyboard shortcuts

On the ScriptTask page, press `?` to see these:

| Keys | Action |
|---|---|
| `g` then `o` `l` `r` `b` `q` `s` `h` `v` `,` | Go to Overview, Library, Run, Batches, Queue, Schedules, History, Variables, Settings |
| `/` | Search on this page |
| `n` | New script (Library), new variable (Variables), or new run |
| `Ctrl+S` | Save the script |
| `Esc` | Close a dialog |

On the device tab, `/` focuses the script picker.

## Scheduling

Schedules run once, or every N minutes, hours, days or weeks (on chosen weekdays), optionally until an end date. A schedule on several devices is a scheduled batch with one schedule per device: **Edit schedule** on the batch changes all of them together, and the Schedules page can edit any selection of schedules at once. Each edited schedule restarts from now and its pending run is replaced; paused schedules stay paused. Daily and weekly schedules keep their wall-clock time in the time zone they were created in, across daylight-saving changes.

A run only happens while its device is online. Each schedule chooses what happens otherwise:

- **If the device is offline:** run when it reconnects, run only if it reconnects within a set time, or skip. Runs that don't happen are recorded as **Missed**. A device that was offline never gets a burst of catch-up runs: only the latest due run is kept.
- **If a run happens late:** keep the original timetable, or shift the following runs to when it actually ran.

Each run is sent to its device once. If the device or its agent restarts before the script reports back (a script that reboots the device, for example), the run is recorded as **Interrupted** and isn't run again; use Run again if you want it rerun.

## On the device

The agent writes each script, with its variables filled in, and its output to a `scripttask` folder next to the agent program (for example `C:\Program Files\Mesh Agent\scripttask`). Only SYSTEM and Administrators can open it on Windows, and only root elsewhere. If that folder can't be created, the script is not run and the run shows an error: scripts and their variable values are never written to a shared folder such as `/tmp`. The files are deleted when the script finishes, and the folder is emptied whenever the agent starts. Scripts start in that folder, so use full paths for files you want to keep.

## Variables

Scripts can use variables written as `#name#`. A variable can apply to all devices (global), one script, one device group, or one device. When names match, the most specific value wins: device, then device group, then script, then global, then built-in. Names with no value anywhere are replaced with `VAR_NOT_FOUND`.

Built-in variables:

| Variable | Value |
|---|---|
| `#GBL:nodeName#` | The device's name |
| `#GBL:meshName#` | Its device group's name |
| `#GBL:tags#` | Its tags, separated by commas (no spaces) |
| `#GBL:os#` | Its operating system, as MeshCentral reports it (e.g. "Windows 11 Pro") |
| `#GBL:scriptName#` | The script's name |
| `#GBL:runTime#` | When the run was sent, in UTC (ISO 8601, e.g. `2026-10-26T14:05:00.000Z`) |
| `#GBL:nodeId#`, `#GBL:meshId#` | The device's and its group's MeshCentral ids |
| `#GBL:runBy#` | The user, or schedule owner, who started the run |

Values that people can type (the device, group, tag, script and user names, and the operating system text) have these characters replaced by `_` when they are filled in, because a name like `x"; calc; "` could otherwise add a command to a script: `" ' ` $ ; & | < > % ^ \`. Control characters are dropped and the value is cut at 256 characters. The ids, `#GBL:runTime#` and variables you define are inserted exactly as written. They are the least specific level, so a variable you define with the same name (at any scope) replaces the built-in value. Values are inserted exactly as written: `$` and `#` in a value are not treated specially.

Values are filled in when the run is sent to the device, so the latest script and variable values are used. **Secret** variables are hidden in lists and in the editor until revealed. Scripts still receive the real value, so their output can show it.

## Settings

| Setting | Default |
|---|---|
| Skip grace period: how late a "Skip" schedule may still run | 2 minutes |
| How often the queue checks for due runs | 60 seconds |
| Stop scripts that run longer than (the device stops the script and anything it started; 0 for no limit) | 120 minutes |
| When a run sent to a device is flagged "No result yet" | 30 minutes |
| How long finished runs are kept | 90 days |
| Rows per page on the ScriptTask page | 50 |
| Defaults for new schedules: offline handling, late-run handling, start-time step | Run when it reconnects, keep the timetable, 5 minutes |
| Indentation for scripts that don't have any yet | PowerShell and Batch 4 spaces, Bash 2 spaces |

Due runs start as soon as a device connects, whatever the queue interval.

**Large histories:** with NeDB (MeshCentral's default database), History searches every finished run, so its pages slow down as history grows: about 0.7 s per page with 100,000 runs. MongoDB uses indexes and stays around 0.1 s. Keeping history for fewer days also helps.

## Screenshots

| | |
|---|---|
| ![Library and editor](docs/screenshots/library-editor.png) | ![Run on several devices](docs/screenshots/run.png) |
| ![Batch results](docs/screenshots/batch.png) | ![History](docs/screenshots/history.png) |
| ![Variables](docs/screenshots/variables.png) | ![Overview in dark mode](docs/screenshots/overview-dark.png) |

![Device tab](docs/screenshots/device-tab.png)

## Development

The plugin needs no build step to install. Front-end libraries are vendored in `includes/vendor`: Preact and htm, and a CodeMirror bundle built by `tools/build-editor`:

```sh
cd tools/build-editor && npm install && npm run build
```

The permission tests use stubs only and need no MeshCentral: `node --test test/permissions.test.js`.

Server tests run against a stubbed MeshCentral and need the folder whose `node_modules` contains MeshCentral's NeDB:

```sh
MESHCENTRAL_PARENT=/path/to/meshcentral/install node --test test/*.test.js
```

To run them against MongoDB instead, point `MONGODB_URL` at a server (each test uses its own database) and make the `mongodb` driver loadable:

```sh
MONGODB_URL=mongodb://localhost:27017 NODE_PATH=/path/to/node_modules MESHCENTRAL_PARENT=/path/to/meshcentral/install \
  node --test --test-force-exit test/server.test.js
```

Things that need real agents are in the [manual test checklist](docs/testing-checklist.md).

The design notes and plans for the redesign are in [docs/ui-redesign-plan.md](docs/ui-redesign-plan.md).

## License

Apache 2.0. Original plugin by Ryan Blenis; modifications by Desmond Duval (see [NOTICE](NOTICE)). Bundled libraries keep their own licences, listed in `includes/vendor/LICENSE-*`.